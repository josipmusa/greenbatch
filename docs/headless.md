# Headless operation

greenbatch is designed to complete without a human present. This page covers how to
invoke it that way, what it needs from the environment, and what it does when something
is missing.

The behavioural rules are normative and live in the **Headless mode** section of
`skills/greenbatch/SKILL.md`. This page is about wiring.

## The one prerequisite

**A config file must already exist**, at `.claude/greenbatch.yml` or `greenbatch.yml`.

A headless run that finds no config aborts. It does not derive one, and it does not
guess a `gate`. The gate is the entire basis for the claim that these updates are
verified, so a gate nobody approved would make every future run's report untrue. Run
greenbatch once interactively to produce the config, commit it, and every later run can
be scheduled.

## Invocation

```bash
claude -p "/greenbatch run" \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch" \
  --permission-mode acceptEdits
```

The run reports on stdout and always writes `.greenbatch/report.md`. Scheduled callers
should read the file: it exists on every exit path, including an abort in preflight,
which is exactly the case where stdout is least informative.

### GitHub Actions

```yaml
name: dependency update
on:
  schedule:
    - cron: "0 6 * * 1"    # Mondays, 06:00 UTC
  workflow_dispatch:

permissions:
  contents: write          # push deps/* branches
  pull-requests: write     # open the PRs
  security-events: read    # read Dependabot alerts

jobs:
  greenbatch:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0   # the run cuts a branch from origin/<base>

      - uses: actions/setup-node@v5
        with:
          node-version: 22

      # Only for Maven repos.
      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: 21

      - name: Run greenbatch
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          git config user.name  "greenbatch"
          git config user.email "greenbatch@users.noreply.github.com"
          npm install -g @anthropic-ai/claude-code
          claude -p "/greenbatch run" \
            --allowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch" \
            --permission-mode acceptEdits

      - name: Upload the report
        if: always()       # an aborted run is exactly when you want this
        uses: actions/upload-artifact@v4
        with:
          name: greenbatch-report
          path: .greenbatch/report.md
```

`if: always()` on the artifact step is the point of writing the report to a file. A run
that aborted on a dirty tree or a broken base branch still leaves a readable
explanation.

### cron

```cron
0 6 * * 1  cd /srv/checkouts/my-repo && /usr/local/bin/greenbatch-run.sh >> /var/log/greenbatch.log 2>&1
```

```bash
#!/usr/bin/env bash
# greenbatch-run.sh
set -euo pipefail

cd "$(dirname "$0")"
git fetch origin

# The run aborts on a dirty tree anyway; failing here gives a clearer message.
if [ -n "$(git status --porcelain)" ]; then
  echo "greenbatch: checkout is dirty, skipping this run" >&2
  exit 1
fi

claude -p "/greenbatch run" \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch" \
  --permission-mode acceptEdits

# Notify however you like - greenbatch itself has no notification step.
cat .greenbatch/report.md
```

## Required environment

| Need | Why | Without it |
|---|---|---|
| Git write auth for `deps/*` branches | The run pushes its own branches | Report-only mode |
| `gh`, authenticated | Opens the PRs, closes superseded ones | Report-only mode |
| `security-events: read` (or a token with `security_events`) | Reads open Dependabot alerts for security ordering | Alerts skipped, run continues |
| A toolchain per ecosystem: `node` + `npm`, or `mvn` + `java` + `python3` | Discovery and apply | That ecosystem is not detected |
| Enough wall clock | The gate runs once per batch | Budget exhausts, unattempted elements are listed by name |

Nothing here is a secret beyond the API key and the git token, and the run never needs
write access to anything other than its own branches.

### Notifications

There are none, by design. The report on stdout and in `.greenbatch/report.md` is the
whole output. Wire your own around the run - post the file to Slack, email it, open a
ticket - rather than expecting the skill to do it. That keeps the run's failure modes
independent of your notification system's.

## Report-only mode

When `gh` is absent, unauthenticated, or the remote is not GitHub, the run does not
degrade its verification work. It still cuts the branch, applies the tiers, gates every
batch, bisects failures, and commits what passed. What it skips is filing the PRs.

The final report then carries, instead of PR links:

- the branch names it created and whether they were pushed;
- the complete PR bodies, ready to paste;
- the target branch each one is meant for.

Dependabot alerts degrade separately and more quietly: `alerts.sh` prints `[]` and a
note on stderr, and the run proceeds without security ordering.

For a GitLab remote, `glab mr create --description-file` takes the same body. greenbatch
does not build a forge abstraction over `gh` and `glab`, and does not intend to.

## What a headless run does with each stop condition

| Condition | Headless behaviour |
|---|---|
| No config file | **Abort.** Report which paths were checked and what to add. Never invents a gate. |
| Dirty working tree | **Abort.** Never stashes, never commits someone else's work. |
| Gate fails on the clean branch | **Abort.** The base branch is broken; every later failure would be misattributed. |
| Plan is over budget | **Proceeds.** Spends the budget in the plan's order, reports the overage prominently. |
| A tier-2 major needs migration | **Skips and reports.** Identical to interactive. |
| Gate budget exhausted | Stops, lists unattempted elements by name for the next run. |
| Zero updates kept | Pushes nothing, opens nothing, still writes the report. |

Every one of these writes `.greenbatch/report.md`.
