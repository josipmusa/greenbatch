# Headless operation

greenbatch is designed to complete with no human present: a `claude -p` session on a
workstation, a build server, or a cloud VM, started by cron, a systemd timer, or by hand
before lunch. This page covers how to invoke it that way, what it needs from the
environment, and what it does when something is missing.

The behavioural rules are normative and live in the **Headless mode** section of
`skills/greenbatch/SKILL.md`. This page is about wiring.

## The one prerequisite

**A config file must already exist**, at `.claude/greenbatch.yml` or `greenbatch.yml`.

A headless run that finds no config aborts. It does not derive one, and it does not
guess a `gate`. The gate is the entire basis for the claim that these updates are
verified, so a gate nobody approved would make every future run's report untrue. Run
greenbatch once interactively to produce the config, commit it, and every later run can
be scheduled.

Check a config without running anything:

```bash
skills/greenbatch/scripts/core/config.mjs .
```

Exit 0 prints the normalized config, 2 means it is invalid (with the offending line), and
3 means there is none yet.

## Invocation

```bash
claude -p "/greenbatch" \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch" \
  --permission-mode acceptEdits
```

The run reports on stdout and always writes `.git/greenbatch/report.md`. Scheduled
callers should read the file rather than parse stdout: it exists on every exit path,
including an abort in preflight, which is exactly the case where stdout is least
informative. It lives under `.git/` so it never appears in `git status` and never needs
a `.gitignore` entry.

To see what a run would do without doing any of it:

```bash
claude -p "/greenbatch plan" --allowedTools "Bash,Read,Glob,Grep" --permission-mode plan
```

Plan mode writes nothing, so it is safe to point at a dirty tree or a repo you have
never run this against.

### cron

```cron
0 6 * * 1  /srv/greenbatch/run.sh my-repo >> /var/log/greenbatch.log 2>&1
```

```bash
#!/usr/bin/env bash
# /srv/greenbatch/run.sh <checkout-name>
set -euo pipefail

repo="/srv/checkouts/$1"
cd "$repo"

# cron runs with a minimal PATH and no interactive shell profile, so anything
# installed by a version manager has to be put on PATH explicitly.
export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"

git fetch origin

# The run aborts on a dirty tree anyway; failing here gives a clearer message
# and avoids paying for a Claude session to tell you the same thing.
if [ -n "$(git status --porcelain)" ]; then
  echo "greenbatch: $repo is dirty, skipping this run" >&2
  exit 1
fi

claude -p "/greenbatch" \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch" \
  --permission-mode acceptEdits

# Notify however you like - greenbatch itself has no notification step.
cat .git/greenbatch/report.md
```

The `cd "$repo"` matters. An earlier version of this example used
`cd "$(dirname "$0")"`, which puts you in the *script's* directory rather than the
checkout - the run then aborts on "no config found" in a directory that is not a
repository at all.

### systemd timer

Preferable to cron on a server: you get logs in `journalctl`, a `Persistent=true` that
catches up after downtime, and no PATH surprises.

```ini
# /etc/systemd/system/greenbatch@.service
[Unit]
Description=greenbatch dependency update for %i
After=network-online.target

[Service]
Type=oneshot
User=greenbatch
WorkingDirectory=/srv/checkouts/%i
Environment=ANTHROPIC_API_KEY=%S/greenbatch/api-key
ExecStartPre=/usr/bin/git fetch origin
ExecStart=/usr/local/bin/claude -p "/greenbatch" \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch" \
  --permission-mode acceptEdits
```

```ini
# /etc/systemd/system/greenbatch@.timer
[Timer]
OnCalendar=Mon 06:00
Persistent=true

[Install]
WantedBy=timers.target
```

`systemctl enable --now greenbatch@my-repo.timer`, and
`journalctl -u greenbatch@my-repo` for the last run.

### A disposable cloud VM

The recommended shape if the exposure in [SECURITY.md](../SECURITY.md) matters to you -
a run installs dependencies, which executes whatever lifecycle scripts those packages
define. On a throwaway VM or in a container that costs you nothing:

```bash
git clone --depth 50 <repo> work && cd work
git fetch --unshallow origin        # the run cuts a branch from origin/<base>
npm install -g @anthropic-ai/claude-code

git config user.name  "greenbatch"
git config user.email "greenbatch@users.noreply.example.com"

claude -p "/greenbatch" \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch" \
  --permission-mode acceptEdits
```

Full history is not required, but the base branch must be fetchable: the run cuts
`deps/YYYY-MM-DD` from `origin/<base>` rather than from whatever the checkout happens to
be sitting on.

### A note on CI runners

You can run greenbatch from a CI job, but think about what opens the PR. On GitHub in
particular, a PR opened with the job's default token does not trigger workflows, so the
PR arrives with no CI on it - which is a strange result for a tool whose entire premise
is that verification already happened. If you go this route, open the PR with a token
that is allowed to trigger workflows, or accept that the gate greenbatch ran locally is
the only verification that PR will ever have.

Dependabot alerts have a similar catch: the default job token generally cannot read
them, so `alerts.sh` prints `[]` and the run silently loses its security ordering. Give
it a token with `security_events` read access if you want that ordering.

## Required environment

| Need | Why | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY`, or an authenticated CLI | Runs the session at all | Nothing runs |
| Git write auth for `deps/*` branches | The run pushes its own branches | Report-only mode |
| `gh`, authenticated | Opens the PRs, closes superseded ones | Report-only mode |
| A token that can read Dependabot alerts (`security_events`) | Security ordering in tier 2 | Alerts skipped, run continues |
| A toolchain per ecosystem: `node` + `npm`, or `mvn` + `java` + `python3` | Discovery and apply | That ecosystem is not detected |
| Enough wall clock | The gate runs once per batch | Budget exhausts, unattempted elements are listed by name |

Nothing here is a secret beyond the API key and the git token, and the run never needs
write access to anything other than its own branches - `scripts/core/push.sh` refuses
any other ref.

### Notifications

There are none, by design. The report on stdout and in `.git/greenbatch/report.md` is
the whole output. Wire your own around the run - post the file to Slack, email it, open
a ticket - rather than expecting the skill to do it. That keeps the run's failure modes
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
| No config file (`config.mjs` exit 3) | **Abort.** Report which paths were checked and what to add. Never invents a gate. |
| Invalid config (`config.mjs` exit 2) | **Abort**, quoting the file, line, and message. Never repairs it. |
| Dirty working tree | **Abort.** Never stashes, never commits someone else's work. |
| Gate fails on the clean branch | **Abort.** The base branch is broken; every later failure would be misattributed. |
| Plan is over budget | **Proceeds.** Spends the budget in the plan's order, reports the overage prominently. |
| A tier-2 major needs migration | **Skips and reports.** Identical to interactive. |
| Gate budget exhausted | Stops, lists unattempted elements by name for the next run. |
| Zero updates kept | Pushes nothing, opens nothing, still writes the report. |

Every one of these writes `.git/greenbatch/report.md`.
