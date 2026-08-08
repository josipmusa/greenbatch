#!/usr/bin/env bash
# Fetches open Dependabot alerts, projected down to what the run actually needs.
#
# Usage: alerts.sh [repo-dir]
# Prints: [{"package":"brace-expansion","ecosystem":"npm","severity":"high",
#           "ghsa":"GHSA-...","patched_version":"2.1.3","relationship":"transitive",
#           "number":12}]
# Exit:   always 0 - alerts are an enrichment, never a reason to fail a run.
#
# The projection is not cosmetic: a single raw alert carries ~4KB of advisory
# prose, so an unprojected fetch would swamp the run with text nobody reads.
#
# No `gh`, no GitHub remote, or no token: prints [] and says so on stderr. The
# run continues without security ordering rather than stopping.
set -uo pipefail

repo="${1:-.}"
cd "$repo" || exit 0

if ! command -v gh >/dev/null 2>&1; then
  echo "alerts.sh: gh not on PATH - skipping security cross-reference." >&2
  echo '[]'
  exit 0
fi

# per_page=100 without --paginate: one page keeps the output valid JSON, and a
# repo with more than 100 open alerts has a bigger problem than this run. If one
# ever is, the count in the PR body will look short - raise this before adding
# pagination complexity.
if ! out=$(gh api "repos/{owner}/{repo}/dependabot/alerts?state=open&per_page=100" \
  --jq '[.[] | {
          package: .dependency.package.name,
          ecosystem: .dependency.package.ecosystem,
          severity: .security_advisory.severity,
          ghsa: .security_advisory.ghsa_id,
          patched_version: (.security_vulnerability.first_patched_version.identifier // null),
          relationship: .dependency.relationship,
          number: .number
        }]' 2>&1); then
  echo "alerts.sh: could not read Dependabot alerts (${out%%$'\n'*}) - continuing without them." >&2
  echo '[]'
  exit 0
fi

[ -z "$out" ] && out='[]'
echo "$out"
