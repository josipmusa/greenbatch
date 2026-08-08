# greenbatch

**One verified dependency branch per run, instead of a PR per package.**

Dependabot opens one PR per update and each one fires a full CI pipeline. Forty pending
updates against a six-minute pipeline is four hours of CI to be told forty times that
the tests still pass - and forty PRs for someone to shepherd.

greenbatch runs the verification once. It discovers every available update, applies them
in risk-tiered batches on a dedicated branch, gates each batch with **your repo's own
build and test command**, bisects failures so only what actually breaks gets reverted,
and opens one PR per target branch with a report of what was kept, what was reverted and
why, and what it deliberately did not touch.

It is a [Claude Code](https://claude.com/claude-code) skill. It runs interactively or
headless on a schedule. It never merges anything.

<!-- TODO: demo GIF of a full run - discovery, tier-1 batch gate, a bisect, PR opened. -->
<!-- TODO: screenshot of a real PR body, showing the updates table and a reverted entry. -->

## How it is different

|  | Dependabot / Renovate | greenbatch |
|---|---|---|
| PRs per run | one per package or group | one per target branch |
| CI cost | one pipeline per PR | one pipeline, on a pre-verified branch |
| Verification before the PR | none - CI finds out | your own gate, locally, per batch |
| A batch fails | the whole group PR is red | bisected; only the culprit is reverted |
| Majors | opens the PR, you read the changelog | changelog read *first*; unattemptable ones are skipped with a written migration note |
| Updates it cannot take | silent | reported: prereleases, BOM-pinned versions, rejected pins |
| Ecosystem coverage | broad | npm and Maven (adapters wanted) |

The last two rows are the ones to weigh. greenbatch covers less ground than Dependabot,
on purpose, and expects you to keep Dependabot for GitHub Actions, Docker, and Terraform.
What it gives back is a single reviewable diff that has already been tested, and a report
that never lets silence read as "everything is current".

## Quickstart

```bash
# 1. Install the plugin
/plugin marketplace add josipmusa/greenbatch
/plugin install greenbatch@greenbatch

# 2. In the repo you want updated - read-only, changes nothing:
/greenbatch plan

# 3. When the plan looks right, on a clean tree:
/greenbatch
```

`/greenbatch plan` discovers, tiers, and reports what a full run *would* do - the
tier-1 batch, the tier-2 order, everything it would deliberately not take, and the gate
budget it would spend. It cuts no branch, applies nothing, and runs no gate, so it is
safe on any repo including a dirty one. It is the honest way to find out whether this
tool is worth a run on your codebase.

The first full run has no config, so it proposes one derived from your
`.github/dependabot.yml`, asks you to confirm the **gate** command, and writes
`.claude/greenbatch.yml` once you approve. After that the run is fully unattended and
can be scheduled - see [docs/headless.md](docs/headless.md).

Requirements: `git`, `node` (for the planner), plus `npm` or `mvn` + `java` + `python3`
depending on your ecosystem. `gh` is optional; without it the run finishes its work and
prints ready-to-paste PR bodies instead of filing them.

## Config

`.claude/greenbatch.yml` is canonical. If it is absent, `greenbatch.yml` at the repo root
is used instead, so agents other than Claude Code can drive this without a `.claude/`
directory. If both exist, `.claude/` wins and the run says so. Check yours any time with
`scripts/core/config.mjs .`.

```yaml
branches:
  base: main              # the deps branch is cut from here
  targets: [dev, main]    # branches to open PRs toward
gate: "npm ci && npm run verify"   # must exit 0 for a batch to be kept
ecosystems: auto          # or an explicit list: [npm], [maven], [npm, maven]
groups:                   # cross-ecosystem atomic groups
  react: ["react", "react-dom", "@types/react", "@types/react-dom"]
  vite: ["vite", "@vitejs/*"]
risky: ["react", "vite"]  # always tier 2, even for a patch bump
reject: []                # never touch (intentional pins); supports globs
labels: ["dependencies"]
commit_prefix: "build"
max_gate_runs: 30         # one counter across the whole run
```

| Key | Meaning |
|---|---|
| `branches.base` | The deps branch is cut from `origin/<base>` and stays a clean deps-only diff. |
| `branches.targets` | Every target gets a PR. Non-base targets get a derived branch so the base-bound PR is not polluted with their unreleased commits. |
| `gate` | The command that decides whether a batch survives. Include the build step - a gate that only runs unit tests silently weakens every claim in the report. |
| `groups` | Atomic groups that cross ecosystems. Members apply, gate, commit, and revert as one, and the bisect never splits them. |
| `risky` | Forced to tier 2 regardless of bump. Frameworks and bundlers belong here. |
| `reject` | Never touched, and reported as an intentional pin. Supports `*` suffixes. |
| `max_gate_runs` | Budget for the whole run. Tier 1 always completes; tier 2 and the transitive pass spend what is left. |

The file is read by `scripts/core/config.mjs`, not interpreted per run. An unknown key
is an error naming the line and the key you probably meant, never a silent fallback to
the default - `rejects:` for `reject:` would otherwise mean a package you deliberately
pinned gets updated with nothing in the report about it.

Grouping inside an ecosystem needs no config: the npm adapter already treats a shared
scope, and a package with its `@types` stub, as one atomic element.

## How a run goes

1. **Preflight.** Abort on a dirty tree. Record the current branch. Read and validate the
   config. Fetch. Close superseded PRs from previous runs - only ones with a dated
   branch name *and* this tool's marker in the body. Cut `deps/YYYY-MM-DD` from
   `origin/<base>`.
2. **Clean gate.** Run the gate on the untouched branch. If it fails, stop - the base is
   broken and every later failure would be blamed on a dependency.
3. **Discover and plan.** Adapters report the available updates; the planner assigns
   tiers, resolves groups, and estimates the gate budget.
4. **Tier 1** (patch + minor) in one batch, one gate run. On failure, bisect.
5. **Tier 2** (majors, risky, unclassifiable) one at a time, changelog read *before*
   applying. Unattemptable ones are skipped with a migration note, not attempted and
   reverted.
6. **Transitive pass.** `npm audit fix` (never `--force`), gated like everything else.
7. **PRs.** One toward base with the full report, one per other target with a short body.
8. **Restore** your original branch and reinstall, whatever happened.

Full detail in [skills/greenbatch/SKILL.md](skills/greenbatch/SKILL.md); the reasoning in
[docs/design.md](docs/design.md).

## Headless

Headless means a `claude -p` session with nobody watching - on your workstation, a build
server, or a disposable cloud VM - not a particular CI product. The differences from an
interactive run are explicit rather than emergent: an over-budget plan proceeds and
reports instead of asking, a missing or invalid config aborts rather than being guessed
at or repaired, and every stop condition writes `.git/greenbatch/report.md` so a
scheduled run always leaves an artifact.

Invocation examples, cron and systemd timers, required environment, and report-only
mode: [docs/headless.md](docs/headless.md).

## Safety model

greenbatch is an agent following a written procedure, using deterministic scripts for
the mechanical parts. That distinction matters for how much weight each rule below
carries, so the table is split by it rather than presented as one undifferentiated list
of "guarantees".

**Enforced by code.** A script refuses; there is no path around it short of editing the
script.

| Rule | Enforced by |
|---|---|
| **Never force-pushes**, and only ever pushes `deps/YYYY-MM-DD[-target]` branches - never your base or target branches. Refuses refspecs and flags outright. | `scripts/core/push.sh` |
| **Never deletes a branch it did not create.** Stale-PR cleanup needs a dated branch name *and* a run marker in the PR body. | `scripts/core/push.sh`, SKILL.md step 1.7 |
| **Never commits a no-op.** An apply that changed nothing exits 4 and is treated as an error. | `scripts/adapters/*/apply`, conformance |
| **Never applies a version it did not discover and report.** The version is part of the element id; conformance compares what landed against what was planned. | `conformance/run.sh`, stage 4 |
| **Never silently accepts a config it did not understand.** An unknown key or wrong type is an error with a line number, not a fallback to defaults. | `scripts/core/config.mjs` |
| **Never invents a gate.** There is no default and no way to supply one implicitly. | `scripts/core/config.mjs` |

**Rules the run follows.** Part of the procedure in
[SKILL.md](skills/greenbatch/SKILL.md), which the agent is instructed to follow, and
which you can read in full.

| Rule | Where |
|---|---|
| **Never merges a PR.** It opens them and stops. | *Safety rules* |
| **Never runs `npm audit fix --force`** - that takes majors without gating them. | Step 6 |
| **Never edits source code to accommodate a breaking change.** It reports what breaks and leaves the decision to you. | Step 5 |
| **Aborts on a dirty working tree.** No stashing, no committing your work. | Step 1 |
| **Aborts if the gate fails on the clean branch**, before touching anything. | Step 2 |
| **Restores your original branch on every exit path** - success, abort, or failure - and reinstalls so your tree matches it. | Step 8 |

The scripts are readable in an afternoon and runnable outside any agent. See
[SECURITY.md](SECURITY.md) for the trust boundaries, including what running this against
a repository means for the code it executes.

## Ecosystems

**Core:** npm, Maven.

Everything ecosystem-specific lives behind a published contract, so adding one is a
self-contained job: four scripts, a manifest, a fixture, and a passing conformance run.
See [docs/adapters.md](docs/adapters.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

Wanted next: **Python (uv/pip), Go, Rust.**

## Known gaps

Stated plainly rather than discovered later:

- **Single-manifest repos only.** No workspace or monorepo support: one `package.json`
  or one `pom.xml` at the root.
- **Multi-module Maven is partially covered.** Discovery scans the root pom only, which
  in the usual layout is where `<properties>` and `<dependencyManagement>` live, so most
  versions are still found and moved. Anything declared in a child module is not, and
  the run says so in the report rather than letting it read as current. Full reactor
  support is the next thing planned for the Maven adapter.
- **npm only, among Node package managers.** pnpm, yarn, and bun projects are declined
  rather than mismanaged; each needs its own adapter.
- **npm and Maven only.** Everything else needs an adapter.
- **GitHub only for PR filing.** Other forges get report-only mode.
- **No notification step**, by design.

## License

MIT. See [LICENSE](LICENSE).
