#!/usr/bin/env bash
# The only script in greenbatch that mutates a remote.
#
# Usage:
#   push.sh push   <branch>     push a deps branch to origin
#   push.sh delete <branch>     delete a deps branch from origin
#
# Exit: 0 done; 2 refused, or usage error
#
# Every push and every remote branch deletion a run performs goes through here,
# so the safety rules about remotes are enforced by code rather than followed by
# procedure. Three of them:
#
#   - Only `deps/YYYY-MM-DD` and `deps/YYYY-MM-DD-<target>` branches are
#     touchable. That is exactly the set this skill creates. A human's
#     `deps/fix-lockfile` does not match, which matters most for `delete`:
#     stale-PR cleanup used to run against a `deps/*` glob and would happily
#     have deleted someone's unrelated branch.
#   - Nothing is ever force-pushed. There is no flag for it here, and anything
#     that could smuggle one through - a leading `-` or `+`, a colon refspec -
#     is refused before git sees it.
#   - Branches are pushed by explicit refspec, so a repo-local `push.default`
#     cannot redirect a push onto a base or target branch.
#
# A non-fast-forward push failing is correct behaviour, not a case to work
# around: the run never needs to overwrite a remote branch.
set -euo pipefail

REMOTE=origin

# deps/2026-08-08, or deps/2026-08-08-dev for a derived branch.
DEPS_BRANCH='^deps/[0-9]{4}-[0-9]{2}-[0-9]{2}(-[A-Za-z0-9._/-]+)?$'

usage() {
  cat >&2 <<'EOF'
usage: push.sh push   <branch>
       push.sh delete <branch>

Only deps/YYYY-MM-DD[-target] branches may be pushed or deleted.
EOF
}

if [ $# -ne 2 ]; then
  usage
  exit 2
fi

action="$1"
branch="$2"

# Refuse anything that is not a plain branch name before it reaches git: a
# leading '-' is an option, a '+' is a force refspec, and a ':' is a refspec
# that could name a different destination than the source.
case "$branch" in
  -* | +* | *:* | *' '* | '')
    echo "push.sh: refusing '$branch' - only a plain branch name is accepted, never a refspec or a flag." >&2
    exit 2
    ;;
esac

if ! [[ "$branch" =~ $DEPS_BRANCH ]]; then
  echo "push.sh: refusing to $action '$branch'." >&2
  echo "         Only branches this skill creates may be pushed or deleted:" >&2
  echo "         deps/YYYY-MM-DD or deps/YYYY-MM-DD-<target>." >&2
  exit 2
fi

case "$action" in
  push)
    # Explicit refspec on both sides: the source and the destination cannot
    # diverge, whatever push.default is set to in this repo.
    git push "$REMOTE" "refs/heads/$branch:refs/heads/$branch"
    ;;
  delete)
    git push "$REMOTE" --delete "refs/heads/$branch"
    ;;
  *)
    echo "push.sh: unknown action '$action'." >&2
    usage
    exit 2
    ;;
esac
