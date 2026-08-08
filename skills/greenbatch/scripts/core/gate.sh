#!/usr/bin/env bash
# Runs the configured gate command, capturing output for the PR body.
#
# Usage: gate.sh <log-file> <command string>
# Prints: {"exit":0,"elapsed_seconds":142,"log":"/path/to/log"}
# Exit:   the gate command's own exit code
#
# Notes:
# - CI=true is forced. In a repo whose `npm test` is a bare `vitest`, the runner
#   waits forever in watch mode without it, and a hung gate looks identical to a
#   slow one.
# - No `timeout` dependency: it does not exist on macOS. Keep it that way - the
#   whole script set has to run unmodified on a developer laptop and a CI runner.
# - Output goes to the log file, not the console, so the caller can quote just
#   the relevant part of a failure. Read the log's tail to diagnose.
set -uo pipefail

if [ $# -lt 2 ]; then
  echo "usage: gate.sh <log-file> <command string>" >&2
  exit 2
fi

log="$1"
shift
cmd="$*"

mkdir -p "$(dirname "$log")"

start=$(date +%s)
CI=true bash -c "$cmd" >"$log" 2>&1
code=$?
elapsed=$(($(date +%s) - start))

printf '{"exit":%d,"elapsed_seconds":%d,"log":"%s"}\n' "$code" "$elapsed" "$log"
exit "$code"
