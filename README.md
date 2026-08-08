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
/plugin marketplace add OWNER/greenbatch
/plugin install greenbatch@greenbatch

# 2. In the repo you want updated, on a clean tree:
/greenbatch run
```

The first run has no config, so it proposes one derived from your `.github/dependabot.yml`,
asks you to confirm the **gate** command, and writes `.claude/greenbatch.yml` once you
approve. After that the run is fully unattended and can be scheduled - see
[docs/headless.md](docs/headless.md).

Requirements: `git`, `node` (for the planner), plus `npm` or `mvn` + `java` + `python3`
depending on your ecosystem. `gh` is optional; without it the run finishes its work and
prints ready-to-paste PR bodies instead of filing them.

## Config

`.claude/greenbatch.yml` is canonical. If it is absent, `greenbatch.yml` at the repo root
is used instead, so agents other than Claude Code can drive this without a `.claude/`
directory. If both exist, `.claude/` wins and the run says so.

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

Grouping inside an ecosystem needs no config: the npm adapter already treats a shared
scope, and a package with its `@types` stub, as one atomic element.

## How a run goes

1. **Preflight.** Abort on a dirty tree. Record the current branch. Fetch. Close stale
   `deps/*` PRs from previous runs. Cut `deps/YYYY-MM-DD` from `origin/<base>`.
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

greenbatch is built to run unattended, and the differences are explicit rather than
emergent: an over-budget plan proceeds and reports instead of asking, a missing config
aborts rather than inventing a gate, and every stop condition writes
`.greenbatch/report.md` so a scheduled run always leaves an artifact.

Invocation examples, a GitHub Actions workflow, required environment, and report-only
mode: [docs/headless.md](docs/headless.md).

## Safety model

These are guarantees, not intentions. Each points at the code that enforces it.

| Guarantee | Where |
|---|---|
| **Never force-pushes.** Only ever pushes its own `deps/*` branches. | SKILL.md, *Safety rules* |
| **Never pushes to your base or target branches.** | SKILL.md, *Safety rules* and step 7 |
| **Never merges a PR.** It opens them and stops. | SKILL.md, *Safety rules* |
| **Never runs `npm audit fix --force`** - that takes majors without gating them. | SKILL.md step 6 |
| **Never edits source code to accommodate a breaking change.** It reports what breaks and leaves the decision to you. | SKILL.md step 5 |
| **Aborts on a dirty working tree.** No stashing, no committing your work. | SKILL.md step 1 |
| **Aborts if the gate fails on the clean branch**, before touching anything. | SKILL.md step 2 |
| **Restores your original branch on every exit path** - success, abort, or failure - and reinstalls so your tree matches it. | SKILL.md step 8 |
| **Never commits a no-op.** An apply that changed nothing exits 4 and is treated as an error. | `scripts/adapters/*/apply`, `docs/design.md` |
| **Mechanical operations are deterministic, auditable scripts**, not commands improvised per run. | `scripts/`, `docs/adapters.md` |

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
  or one `pom.xml` tree at the root. Multi-module Maven poms are reverted correctly, but
  discovery reads the root pom.
- **npm and Maven only.** Everything else needs an adapter.
- **GitHub only for PR filing.** Other forges get report-only mode.
- **No notification step**, by design.

## License

MIT. See [LICENSE](LICENSE).
