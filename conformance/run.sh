#!/usr/bin/env bash
# Adapter conformance suite.
#
# Usage: conformance/run.sh [--strict] <adapter> <fixture-dir>
#   e.g. conformance/run.sh npm   fixtures/npm-basic
#        conformance/run.sh maven fixtures/maven-basic
#
# An adapter that passes this suite satisfies the contract in docs/adapters.md
# and is mergeable. Nothing here knows anything about a specific ecosystem: the
# adapter's own manifest supplies the tool list and the deliberately-unmatched
# element id, and every assertion is made through git and the facts JSON.
#
# The fixture must be a committed part of this repository - "revert restores the
# tree" is checked against git HEAD, so an uncommitted fixture cannot be graded.
#
# --strict turns a missing required tool into a failure instead of a skip. CI
# uses it so a runner that silently lost its JDK cannot report a green suite.
#
# Exit: 0 pass (or skipped); 1 fail; 2 usage error
set -euo pipefail

strict=false
if [ "${1:-}" = "--strict" ]; then
  strict=true
  shift
fi

if [ $# -ne 2 ]; then
  echo "usage: conformance/run.sh [--strict] <adapter> <fixture-dir>" >&2
  exit 2
fi

adapter_name="$1"
fixture="$2"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
adapter="$repo_root/skills/greenbatch/scripts/adapters/$adapter_name"
manifest="$adapter/adapter.json"

step=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; exit 1; }
note() { printf '       %s\n' "$1"; }

echo "conformance: adapter '$adapter_name' against fixture '$fixture'"

# ---------------------------------------------------------------- preflight

[ -d "$adapter" ] || fail "no adapter at $adapter"
[ -f "$manifest" ] || fail "adapter has no adapter.json"
[ -d "$repo_root/$fixture" ] || [ -d "$fixture" ] || fail "no fixture at $fixture"

fixture_abs="$(cd "$repo_root/$fixture" 2>/dev/null || cd "$fixture"; pwd)"

for script in detect discover apply revert; do
  [ -x "$adapter/$script" ] || fail "adapter/$script is missing or not executable"
done
pass "adapter exposes executable detect, discover, apply, revert"

# The adapter declares what it needs; skip rather than report a false failure on
# a machine that simply does not have the toolchain installed.
missing=""
read_json='const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));'

while IFS= read -r tool; do
  [ -n "$tool" ] || continue
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done < <(node -e "$read_json"'
  for (const t of j.requires ?? []) console.log(t)
' "$manifest")

if [ -n "$missing" ]; then
  if [ "$strict" = true ]; then
    fail "required tools not on PATH:$missing (running with --strict)"
  fi
  echo "  SKIP $adapter_name conformance - required tools not on PATH:$missing"
  echo "       Install them, or re-run without --strict to keep skipping."
  exit 0
fi
pass "required tools present"

# Every assertion below compares against git HEAD, so the fixture has to be
# clean before we start touching it.
if [ -n "$(git -C "$repo_root" status --porcelain -- "$fixture_abs")" ]; then
  fail "fixture is dirty before the run - commit or restore it first"
fi
pass "fixture is clean at HEAD"

fixture_dirty() { [ -n "$(git -C "$repo_root" status --porcelain -- "$fixture_abs")" ]; }

restore() {
  if fixture_dirty; then
    echo "conformance: restoring fixture after an incomplete run" >&2
    "$adapter/revert" "$fixture_abs" >/dev/null 2>&1 || true
    git -C "$repo_root" checkout -- "$fixture_abs" 2>/dev/null || true
  fi
}
trap restore EXIT

facts=$(mktemp)
trap 'restore; rm -f "$facts"' EXIT

# ---------------------------------------------------------------- 1. detect

step=$((step + 1))
"$adapter/detect" "$fixture_abs" || fail "detect did not recognise its own fixture"
pass "detect recognises the fixture"

# A detect that returns 0 for everything is useless to the orchestrator.
if "$adapter/detect" "$repo_root/conformance" 2>/dev/null; then
  fail "detect claims a directory with no manifest of its ecosystem"
fi
pass "detect rejects an unrelated directory"

# ---------------------------------------------------------------- 2. discover

step=$((step + 1))
"$adapter/discover" "$fixture_abs" >"$facts" || fail "discover exited non-zero"

node "$repo_root/conformance/validate-facts.mjs" "$facts" || fail "discover output does not satisfy the facts contract"
pass "discover emits contract-valid facts JSON"

# Rule 6: discover is side-effect free. The run re-discovers after cutting the
# branch, so a discover that writes would corrupt the very tree it describes.
fixture_dirty && fail "discover modified the working tree - it must be side-effect free"
pass "discover left the working tree untouched"

# ---------------------------------------------------------------- 3. apply

step=$((step + 1))
element_id=$(node -e "$read_json"'
  const updates = j.updates ?? []
  if (updates.length === 0) {
    console.error("fixture offers no updates - pin its dependencies further behind")
    process.exit(1)
  }
  // Prefer a stable target, the way a real run would: a prerelease is never
  // applied automatically.
  const pick = updates.find((u) => u.prerelease !== true) ?? updates[0]
  console.log(pick.id)
' "$facts") || fail "could not choose an element to apply"

note "applying element: $element_id"
"$adapter/apply" "$fixture_abs" "$element_id" >/dev/null || fail "apply exited non-zero for a discovered element"
fixture_dirty || fail "apply reported success but changed nothing in the tree"
pass "apply changes the manifest for a discovered element"

# ---------------------------------------------------------------- 4. exit 4

step=$((step + 1))
unmatched=$(node -e "$read_json"'
  const id = j.conformance?.unmatchedId
  if (!id) {
    console.error("adapter.json must declare conformance.unmatchedId")
    process.exit(1)
  }
  console.log(id)
' "$manifest") || fail "adapter.json is missing conformance.unmatchedId"

set +e
"$adapter/apply" "$fixture_abs" "$unmatched" >/dev/null 2>&1
code=$?
set -e
[ "$code" -eq 4 ] || fail "apply on an unmatched element exited $code, contract requires 4"
pass "apply exits 4 when nothing changed"

# ---------------------------------------------------------------- 5. revert

step=$((step + 1))
"$adapter/revert" "$fixture_abs" || fail "revert exited non-zero"
if fixture_dirty; then
  git -C "$repo_root" status --porcelain -- "$fixture_abs" >&2
  fail "revert left the fixture differing from git HEAD"
fi
pass "revert restores the fixture byte-identically to HEAD"

echo "conformance: $adapter_name PASSED ($step stages)"
