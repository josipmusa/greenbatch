---
name: greenbatch
description: Use when the user wants a repo's dependencies updated in one verified batch instead of Dependabot's per-package PR flood - "run greenbatch", "run the dependency update", "update deps for this repo", "do the weekly dependency run", "bump everything that's safe", "are there dependency updates to take". Discovers every available npm and Maven update, applies it in risk-tiered batches on a dedicated branch, verifies each batch with the repo's own build+test gate, bisects failures to revert only what breaks, and opens one PR per target branch with a report of what was kept, reverted, and skipped. Runs interactively or headless; it never merges anything. NOT for GitHub Actions, Docker, or Terraform updates (Dependabot and Renovate keep those), and NOT for fixing code to accommodate a breaking change.
---

# greenbatch: one verified dependency branch per run

One verified branch and 1-2 PRs per run, instead of one PR and one full CI pipeline
per package. The expensive CI runs once, on a branch where every commit already
passed the repo's own gate locally.

**The scripts do the mechanical work; you do the judgment.** Discovery, application,
reverting, gating, alert-fetching, and the entire tier/group calculation are
deterministic scripts under `scripts/`. Use them rather than composing raw `ncu` or
`mvn` commands - they encode failure modes that are invisible otherwise (see each
script's header comments). What is yours: reading changelogs to decide whether a
major is attemptable, diagnosing gate failures, resolving lockfile conflicts, and
writing PR bodies a human can trust without re-running anything.

Reach for raw commands only in states the scripts do not cover - a merge conflict, an
unexpected repo layout.

## Layout

```
scripts/core/config.mjs             # find + validate the config -> normalized JSON
scripts/core/detect.sh              # which adapters apply to this repo
scripts/core/plan.mjs               # facts + config -> tiered, grouped plan
scripts/core/gate.sh                # runs the gate command, captures the log
scripts/core/alerts.sh              # open Dependabot alerts, projected
scripts/core/push.sh                # the only script that touches a remote
scripts/adapters/<ecosystem>/       # detect, discover, apply, revert, adapter.json
templates/pr-body.md
```

Core knows nothing about any ecosystem. Everything npm- or Maven-specific lives in an
adapter behind the contract in `docs/adapters.md`. Adapters emit **facts JSON**; core
consumes it. Each update in that JSON carries an **`id`** - the element id. To apply
something, hand its members' `id` values straight back to that adapter's `apply`.
Never construct or edit an id yourself: only the adapter knows what its ids mean.

## Config: `.claude/greenbatch.yml`

```yaml
branches:
  base: main              # the deps branch is cut from here
  targets: [dev, main]    # branches to open PRs toward
gate: "npm ci && npm run verify"   # must exit 0 for a batch to be kept
ecosystems: auto          # or an explicit list: [npm], [maven], [npm, maven]
groups:                   # cross-ecosystem atomic groups (see Grouping)
  react: ["react", "react-dom", "@types/react", "@types/react-dom"]
  vite: ["vite", "@vitejs/*"]
risky: ["react", "vite"]  # always tier 2, even for a patch bump
reject: []                # never touch (intentional pins); supports globs
labels: ["dependencies"]
commit_prefix: "build"
max_gate_runs: 30
```

**Do not read this file yourself.** `scripts/core/config.mjs` finds it, applies the
precedence rule, validates it, and prints the normalized JSON `plan.mjs` consumes:

```bash
scripts/core/config.mjs <repo> > config.json
```

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Valid. Normalized JSON on stdout, including `gate`, `base`, `targets`, `derivedTargets`. | Continue. |
| 2 | The config exists but is wrong - unknown key, wrong type, unsupported YAML. stderr names the file, the line, and usually the key that was meant. | **Stop and report it verbatim.** Do not "fix" the config and do not fall back to defaults. |
| 3 | No config file at either path. | Interactive: run the bootstrap below. Headless: abort - see **Headless mode**. |

Exit 2 is a stop, not a warning. The reason config parsing is a script at all is that
a typo used to fail silently and in the worst direction: `rejects:` instead of `reject:`
meant the reject list was empty, so a package the user had deliberately pinned got
updated and nothing in the report mentioned it.

**Precedence**, which `config.mjs` implements: `.claude/greenbatch.yml` is canonical. If
it is absent, `greenbatch.yml` at the repo root is used - agents other than Claude Code
run this skill, and a repo that does not otherwise have a `.claude/` directory should
not need one. If both exist, the canonical one wins, `config.mjs` says so on stderr, and
you carry that into the run report. Nothing else is a config source.

### When the config file is missing (interactive only)

**This bootstrap requires a human and must never run headless.** Derive the config
from the repo's `.github/dependabot.yml`, show the result, and write it only after
the user approves. Commit it on the deps branch so the first PR carries it. With no
human to approve it, abort instead - see **Headless mode**.

**Transfers:** real atomic groups (react, vite, a UI kit's scope), `labels`, the
`commit-message.prefix`, and target branches - dual `target-branch: dev` +
`target-branch: main` npm blocks collapse into `targets: [dev, main]` with
`base: main`.

**Dropped:** `dev-dependencies` and `minor-and-patch`. Those are PR-batching groups
and the tier system replaces them. Carrying them over would create one enormous
"group" that the bisect is forbidden to split.

**Cannot be derived - do not invent:**

- **`gate`** - guess out loud and get confirmation. Read `package.json` scripts or the
  Maven setup and propose ("`verify` is `lint && typecheck && test && build` - use
  `npm ci && npm run verify`?"). Never write a gate the user has not seen. A gate
  missing the build step silently weakens every verification in the run, and the
  whole value of this skill is that the gate was real.
- **`risky`** - default to empty; suggest candidates from the manifest (framework and
  bundler packages) and let the user decide.
- **`reject`** - empty.

Once the file exists it is the only source of config; `dependabot.yml` is never read
for config again. (The overlap check below still reads it, but only to see which
ecosystems Dependabot still owns.)

## Procedure

### 1. Preflight

1. **Abort if the working tree is dirty.** Do not stash, do not commit. Report what is
   dirty and stop.
2. Record the current branch - you restore it at the end, on success or failure.
3. `scripts/core/config.mjs <repo>` for the config. Handle exits 2 and 3 as above.
4. `git fetch origin`.
5. `scripts/core/detect.sh` for ecosystems (or the config's explicit list). None → stop.
6. **Overlap check:** read `.github/dependabot.yml`. If blocks are still enabled for an
   ecosystem this run covers, warn the user and note it in the PR body. Non-blocking.
7. **Close stale PRs from previous runs.** Both conditions must hold before you close
   or delete anything:
   - the head branch matches `deps/YYYY-MM-DD` or `deps/YYYY-MM-DD-<target>` exactly -
     a date, not a `deps/*` glob; and
   - the PR body carries the `<!-- greenbatch-run: ... -->` marker from
     `templates/pr-body.md`.

   A `deps/*` glob alone is not enough: `deps/fix-lockfile` is a perfectly ordinary
   branch for a human to push, and closing someone's PR and deleting their branch is
   the only destructive thing this run does. Anything matching only one condition gets
   mentioned in the report and left alone. Delete branches with
   `scripts/core/push.sh delete <branch>`, which enforces the same pattern.

   Note the supersession in the new PR bodies; the closed PRs' updates get
   rediscovered here.
8. Cut `deps/YYYY-MM-DD` from `origin/<base>`.

### 2. Clean gate - the one that must pass

Run the gate on the untouched branch. If it fails, **abort immediately**: the base
branch is broken, and every later failure would be misattributed to a dependency.
Report the failure and stop without changing anything.

This also installs dependencies, which npm discovery needs.

### 3. Discover and plan

**Discover on the deps branch, after step 1 cut it from `origin/<base>`.** Never reuse
discovery from before the fetch, and never discover in a checkout sitting on a stale
local branch. The user's `main` is often behind `origin/main`, so facts gathered there
describe a tree the run is not building: `from` versions are wrong, and packages already
updated on the real base show up as pending work. The result is a plan that cannot apply
and a PR body full of version numbers that were never true.

```bash
scripts/adapters/npm/discover    <repo> > npm-facts.json
scripts/adapters/maven/discover  <repo> > mvn-facts.json
scripts/core/alerts.sh           <repo> > alerts.json
scripts/core/plan.mjs --config config.json --discover npm-facts.json [--discover mvn-facts.json] --alerts alerts.json
```

Run `discover` for every adapter `detect.sh` reported true, and only those.

The plan gives you `tier1`, `tier2` (already in execution order), and
`estimatedGateRuns` vs `maxGateRuns`. If `overBudget` is true, say so up front with the
numbers - the user may want to raise the cap or narrow the run before spending an hour
of gate time. Headless, you proceed instead; see **Headless mode**.

`notes` carries caveats about what discovery did **not** look at - a multi-module Maven
project whose child modules went unscanned, for instance. These are not updates, so they
have their own section in the report and the PR body. A reader who is not told about
them reads the report as covering the whole project.

It also gives three lists of updates that exist but will **not** be applied. All three
belong in the PR body: staying silent about them reads as "everything is current",
which is the one wrong impression this report must not leave.

- `rejected` - matched the config's `reject` list (an intentional pin).
- `prerelease` - the newer version is an RC/alpha/beta. Adopting a prerelease is a
  deliberate human call, so the run never makes it. Concrete shape: a library whose
  `latest` dist-tag currently resolves to `2.1.0-alpha1` while `2.0.x` is the stable
  line.
- `unmanageable` - a version with no lever, such as a Maven dependency pinned by the
  parent or an imported BOM. It moves when the parent moves. Do not add a `<version>`
  override to force it.

**Tiers:** tier 1 is patch + minor excluding `risky`; tier 2 is majors, `risky`
packages, anything an adapter flagged `risky` (a parent POM bump), and any update whose
bump the adapter could not classify. `plan.mjs` decides this - do not re-derive it.

**Grouping:** a group is atomic. All members apply, gate, and commit together; the
bisect never splits inside one; on failure the whole group reverts and reports as one
row. Explicit config groups and adapter-supplied families both merge into single
elements, and a group's tier is the highest of its members'.

### 4. Tier 1 - one batch, then bisect on failure

Apply every tier-1 element at once and gate once. Pass → one commit, done.

Fail → **bisect.** Split the element list in half, apply and gate each half, recursing
into a failing half. Elements in a passing half get committed; a failing leaf element
gets reverted with its gate log kept for the PR body. Groups are single elements and
are never split.

Revert with the adapter's `revert` - it also reinstalls, so the next gate runs against
a tree that matches the reverted manifest.

**Tier 1 is never cut short by the budget.** It runs first and completes, bisect
included. The patch/minor batch is the highest-value, lowest-risk work in the run, and
a majors-heavy repo must not starve it. Only tier 2 and the audit pass are
budget-capped. Do not reorder these phases.

### 5. Tier 2 - one element at a time

In the plan's order (security-relevant first). For each element, while gate runs
remain in the budget:

1. **Read the changelog or release notes first**, before applying anything. `gh api
   repos/<owner>/<repo>/releases` or WebFetch the project's changelog.
2. **Decide:**
   - Breaking changes that need code migration → **skip without attempting.** Report as
     "needs human migration" with a concrete summary of what breaks *in this repo*.
     Attempting it burns a gate run to learn what the changelog already said.
   - Trivial breaking changes the repo does not touch (a renamed option it never
     passes, a dropped Node version it does not target) → attempt it.
   - No breaking changes → attempt it.
3. Apply, gate. Pass → commit. Fail → revert, keep the gate log, report it.

This judgment needs no human: skipping and reporting is a complete outcome, so it works
identically headless.

When the budget runs out, stop and list the untouched elements by name as "not
attempted" so the next run picks them up.

### 6. Transitive pass (audit-capable ecosystems)

For each ecosystem whose facts declare the `audit` capability, run its transitive fix -
for npm, `npm audit fix` (**never** `--force`, which takes majors without gating them).
Gate once. Green → commit. Red → revert. This is what resolves lockfile-only transitive
alerts.

### 7. Finalize

**Zero updates kept → do not push, do not open PRs.** Report the summary and go to
step 8.

The deps branch is **never** contaminated with commits from another branch:

- `deps/YYYY-MM-DD` was cut from `origin/<base>` and stays a clean deps-only diff.
  Push it and open a PR toward `base` (when `base` is in `targets`). This PR carries
  the full report.
- For every **other** target: create `deps/YYYY-MM-DD-<target>` from `origin/<target>`,
  merge the deps branch into it, push, re-run the gate on it, and open a PR toward that
  target with the short body. This carries the updates across without leaking the
  target's unreleased commits into the main-bound branch.

**Push with `scripts/core/push.sh push <branch>`, never with raw `git push`.** It is the
only thing in this skill that mutates a remote, and it refuses any ref that is not a
`deps/YYYY-MM-DD[-target]` branch, refuses force refspecs, and pushes by explicit
refspec so a repo-local `push.default` cannot redirect it. If it refuses a branch, that
is a bug in the branch name - report it rather than working around it with `git push`.

**Merge conflicts on a derived branch.** Lockfile conflicts: take the manifest merge,
regenerate (`npm install`), re-run the gate on that branch, and note it in that PR's
body. Any non-lockfile conflict: do not attempt a resolution. Push what you have, open
the PR marked as conflicted, and flag it for a human at the top of the body.

Write PR bodies from `templates/pr-body.md`, filled from the run's actual records - the
plan, the apply output, and the saved gate logs. Never describe an update you did not
verify against those.

**Open the PR first, then label it. Never pass `--label` to `gh pr create`.** That flag
fails the entire creation when the label does not exist on the repo, so a run that
discovered, gated, bisected, and pushed correctly ends with no PR at all - and a
repository that has never had a dependency bot on it has no `dependencies` label, which
makes this the *default* outcome on a first run rather than an edge case.

```bash
gh pr create --base <target> --head <branch> --title "..." --body-file <body>   # no --label
gh label create <name> --color 0366d6 --description "Dependency updates"        # only if missing
gh pr edit <url> --add-label <name>
```

Creating a missing label is honouring the config, not exceeding it - `labels` is the
user asking for exactly this - but say so in the report's **Notes**, because it is a
change to their repository's settings that they did not watch happen.

If labelling fails anyway, **leave the PR alone and note it**. The PR is the deliverable
and it already exists; a missing label is a line in the report, not a failed run. Never
delete and recreate a PR to fix its labels.

**Report-only mode.** If `gh` is missing, unauthenticated, or the remote is not GitHub,
do not try to work around it. Push nothing beyond the `deps/*` branches you already
created, and print the branch names plus the complete, ready-to-paste PR bodies in the
final report instead. The verification work is still done and still on a branch; only
the PR filing is left to a human. For a GitLab remote, `glab mr create` takes the same
body from the same file - suggest it, but do not build a second forge integration into
the run.

### 8. Restore, then report

Return to the branch recorded in step 1 and leave the tree clean. **Do this whether the
run succeeded, aborted, or failed** - the user's checkout is not yours to leave moved.

For npm repos, re-run `npm ci` after switching back. The run's installs left
`node_modules` matching the deps branch's lockfile, so without this the user's checkout
has the restored branch's `package.json` and the wrong dependencies on disk - a
confusing state to hand back, and one they did not ask for.

Then report: kept, reverted, skipped, not attempted, available-but-not-taken, discovery
notes, alerts resolved, gate runs and total gate time, and the PR links.

**Always write the report to `.git/greenbatch/report.md` as well as stdout**, and print
that path at the end of the run. Every exit path writes it, including an abort - a
scheduled run that stopped in preflight has to leave an artifact saying so, or the next
person sees only an exit code.

It goes under `.git/` on purpose. git never tracks anything there, so the report needs
no `.gitignore` entry, never appears in `git status`, and survives the branch switches
the run makes. The alternative - a `.greenbatch/` directory at the repo root - meant
either editing the user's `.gitignore` or handing back a tree with an untracked
directory in it, and this run promises to leave the checkout as it found it.

## Plan-only mode

`/greenbatch plan` answers "what would this do?" without doing any of it. It is the
cheapest way to try greenbatch on an unfamiliar repo, and the honest way to check a
config change.

Run steps 3's scripts and nothing else: read the config, detect ecosystems, `discover`,
`alerts.sh`, `plan.mjs`. Then report the tier-1 batch, the tier-2 order, the three
not-taken lists, any `notes`, and `estimatedGateRuns` against `maxGateRuns`.

**Cut no branch, apply nothing, run no gate, push nothing, open no PR.** Nothing in this
mode writes to the working tree, so unlike a real run it is safe on a dirty tree - but
say which branch the numbers describe. They come from the current checkout, not from
`origin/<base>`, so a stale local branch gives a stale plan (see step 3). If the
checkout is behind its remote, say so next to the numbers.

## Headless mode

The run is designed to complete with no human present. Everything above applies, with
these differences when nobody can answer a question:

- **Config file missing (`config.mjs` exit 3) → abort.** Write the report with the
  paths `config.mjs` listed and what to do about it. **Never invent a `gate`, and never
  write a config file without approval.** A gate the user has not seen makes every
  "verified" claim in every future run untrue, so the bootstrap in *When the config file
  is missing* is interactive-only, without exception.
- **Config invalid (`config.mjs` exit 2) → abort**, quoting the file, line, and message.
  Do not repair it. A scheduled run correcting a config it was not asked to correct is
  how a reject list quietly stops being honoured.
- **`overBudget` plan → proceed, do not ask.** Spend the budget in the order the plan
  already defines: tier 1 to completion, then tier 2 security-first. Report the overage
  prominently at the top of the report and in the PR body, with the estimate, the cap,
  and the elements that went unattempted.
- **Tier-2 changelog judgment → unchanged.** Skip-and-report is a complete outcome and
  needs no human.
- **Dirty tree, or a failing gate on the clean branch → abort and report**, exactly as
  interactive. These mean the run cannot produce a trustworthy result at all, and a
  scheduled run must never "fix" them by stashing or by committing someone's work.
- **Every stop condition writes `.git/greenbatch/report.md`.** Aborts included. Machine
  callers look for that file.

`docs/headless.md` has invocation examples, the required environment, and what
report-only mode looks like when no token is present.

## Safety rules

- **Never force-push, and never push with raw `git push`.** Every push and every remote
  branch deletion goes through `scripts/core/push.sh`, which enforces the first three
  rules here rather than trusting this list to be followed.
- **Never push to `base` or any target branch.**
- **Never merge a PR.** This skill opens them.
- **Never `npm audit fix --force`.**
- **Never fix code to accommodate a breaking change.** Report it; the human decides.
- Abort on a dirty tree at start; restore the original branch at the end regardless.
- Abort if the gate fails on the clean branch.
- Keep every gate log so failures are quotable.

## Failure modes worth recognizing

- **`apply` exits 4** - the manifest is byte-identical, so nothing matched the element
  id. Treat it as a bug in the element list, not as a successful no-op. Never commit it.
  The usual cause is stale discovery (see step 3): the package is already at the target
  version on the real base branch. Re-discover on the branch and re-plan; do not
  hand-edit the element ids to route around it.
- **Maven apply "succeeds" but changes nothing** - the wrong lever for that version.
  The element id carries the mechanism (`property:` / `dependency:` / `parent=`); pass
  the id from the facts JSON unmodified. Exit 4 catches this.
- **Gate hangs** - a watch-mode test runner. `gate.sh` forces `CI=true`; if a gate still
  hangs, the config's gate command needs a non-watch form. A repo whose `npm test` is a
  bare `vitest` waits forever without it, and a hung gate looks identical to a slow one.
- **Everything in tier 1 fails together** - suspect the clean gate was not actually
  green, or a lockfile left over from a previous revert. Re-run the clean gate on the
  branch point before bisecting 20 elements one by one.
- **A Maven update never appears** - it is probably in `unmanageable`: pinned by the
  parent or an imported BOM, with no lever short of overriding the parent's tested
  version set. Report it as such; do not add a version override to force it.
- **`gh pr create` exits non-zero with `could not add label`** - the label in the config
  does not exist on the repo, and no PR was created. Do not retry the same command and
  do not drop the branch: the branch is pushed and the work is intact. Create the label,
  then create the PR without `--label` as step 7 describes. Check with
  `gh pr list --head <branch>` before retrying, so a partially-succeeded creation does
  not become two PRs for one branch.
