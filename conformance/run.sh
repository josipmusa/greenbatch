#!/usr/bin/env bash
# Adapter conformance suite.
#
# Usage: conformance/run.sh [--strict] <adapter> <fixture-dir>
#   e.g. conformance/run.sh npm   fixtures/npm-basic
#        conformance/run.sh maven fixtures/maven-basic
#
# An adapter that passes this suite satisfies the contract in docs/adapters.md
# and is mergeable. Nothing here knows anything about a specific ecosystem: the
# adapter's own manifest supplies the tool list, the deliberately-unmatched
# element id, the near-miss directories it must refuse, and its fixture gate.
# Every assertion is made through git, the facts JSON, and the applied record.
#
# Stages: detect (including declared decoys), discover, apply, pinning, exit 4,
# fixture gate (optional), revert.
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
applied=$(mktemp)
trap 'restore; rm -f "$facts" "$applied"' EXIT

# ---------------------------------------------------------------- 1. detect

step=$((step + 1))
"$adapter/detect" "$fixture_abs" || fail "detect did not recognise its own fixture"
pass "detect recognises the fixture"

# A detect that returns 0 for everything is useless to the orchestrator.
if "$adapter/detect" "$repo_root/conformance" 2>/dev/null; then
  fail "detect claims a directory with no manifest of its ecosystem"
fi
pass "detect rejects an unrelated directory"

# The hard cases are the near misses: a project in the same LANGUAGE managed by
# a different tool. Only the adapter knows what those look like, so it names
# them, and this asserts it actually refuses them. npm declares a pnpm project -
# claiming one means installing with the wrong tool and writing a lockfile the
# project does not use and revert cannot restore.
while IFS= read -r decoy; do
  [ -n "$decoy" ] || continue
  [ -d "$repo_root/$decoy" ] || fail "conformance.rejectFixtures names a missing directory: $decoy"
  if "$adapter/detect" "$repo_root/$decoy" 2>/dev/null; then
    fail "detect claimed '$decoy', which this adapter declares it must refuse"
  fi
  note "declined $decoy, as declared"
done < <(node -e "$read_json"'
  for (const d of j.conformance?.rejectFixtures ?? []) console.log(d)
' "$manifest")

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
"$adapter/apply" "$fixture_abs" "$element_id" >"$applied" || fail "apply exited non-zero for a discovered element"
fixture_dirty || fail "apply reported success but changed nothing in the tree"
pass "apply changes the manifest for a discovered element"

# ------------------------------------------------------------- 4. pinning

# The load-bearing check for the report's honesty: what landed in the manifest
# has to be the version discovery offered, not whatever "latest" resolves to at
# apply time. Without this an adapter can re-resolve on apply and silently take
# a release published mid-run - a major would enter the tier-1 batch with its
# changelog unread, and the PR body would name a version nobody planned.
#
# `to` is compared against the manifest read-back in the applied record, so an
# adapter cannot satisfy this by echoing the id back.
step=$((step + 1))
# shellcheck disable=SC2016  # ${...} here is JS template syntax, not shell
node -e '
  const fs = require("fs")
  const facts = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  const id = process.argv[3]

  let record
  try {
    record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
  } catch (err) {
    console.error(`apply printed no parseable applied record: ${err.message}`)
    process.exit(1)
  }

  if (!Array.isArray(record.applied)) {
    console.error("apply must print {\"applied\": [...]} on stdout")
    process.exit(1)
  }

  const entry = record.applied.find((a) => a && a.id === id)
  if (!entry) {
    console.error(`applied record has no entry for the id it was given (${id})`)
    process.exit(1)
  }
  for (const field of ["id", "name", "to"]) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      console.error(`applied[].${field} must be a non-empty string, got ${JSON.stringify(entry[field])}`)
      process.exit(1)
    }
  }

  const planned = (facts.updates ?? []).find((u) => u.id === id)
  if (!planned) {
    console.error(`the facts no longer contain the id that was applied (${id})`)
    process.exit(1)
  }
  if (entry.to !== planned.to) {
    console.error(
      `apply did not pin the discovered version: discover offered ${planned.to}, ` +
        `the manifest now says ${entry.to}. apply must write the version the ` +
        `element id names rather than re-resolving latest.`,
    )
    process.exit(1)
  }
' "$facts" "$applied" "$element_id" || fail "apply did not pin the version discover offered"
pass "apply pinned exactly the version discover offered"

# ---------------------------------------------------------------- 5. exit 4

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

# ------------------------------------------------------------ 6. fixture gate

# Optional, and the only stage that asks whether the update actually WORKS
# rather than whether the manifest moved. An adapter that declares a gate is
# claiming its apply leaves an installable, usable tree - which is the claim the
# whole tool rests on.
gate=$(node -e "$read_json"'
  process.stdout.write(j.conformance?.gate ?? "")
' "$manifest")

if [ -n "$gate" ]; then
  step=$((step + 1))
  note "fixture gate: $gate"
  if ! (cd "$fixture_abs" && sh -c "$gate") >/dev/null 2>&1; then
    fail "the adapter's declared fixture gate failed after apply"
  fi
  pass "the fixture still builds after the update"
fi

# ---------------------------------------------------------------- 7. revert

step=$((step + 1))
"$adapter/revert" "$fixture_abs" || fail "revert exited non-zero"
if fixture_dirty; then
  git -C "$repo_root" status --porcelain -- "$fixture_abs" >&2
  fail "revert left the fixture differing from git HEAD"
fi
pass "revert restores the fixture byte-identically to HEAD"

echo "conformance: $adapter_name PASSED ($step stages)"
