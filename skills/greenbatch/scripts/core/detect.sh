#!/usr/bin/env bash
# Adapter detection orchestrator: asks every installed adapter whether it applies
# to this repo. Adapters are found on disk, so dropping a new one into
# scripts/adapters/<name>/ is all it takes to be included here.
#
# Usage:  detect.sh [repo-dir]        (default: current directory)
# Prints: {"npm":true,"maven":false}
# Exit:   0 at least one ecosystem found; 3 none found
set -euo pipefail

repo="${1:-.}"
adapters_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../adapters" && pwd)"

found=0
out=""

for manifest in "$adapters_dir"/*/adapter.json; do
  [ -e "$manifest" ] || continue
  adapter_dir="$(dirname "$manifest")"
  name="$(basename "$adapter_dir")"

  present=false
  if [ -x "$adapter_dir/detect" ] && "$adapter_dir/detect" "$repo"; then
    present=true
    found=1
  fi

  [ -n "$out" ] && out="$out,"
  out="$out\"$name\":$present"
done

printf '{%s}\n' "$out"

if [ "$found" -eq 0 ]; then
  echo "detect.sh: no adapter matched '$repo' - nothing this skill can update." >&2
  exit 3
fi
