# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-08

First open-source release. The skill itself is not new - it has been running dependency
updates in production against npm and Maven repositories - but this is the first release
built to be used and extended by anyone.

### Added

- **The greenbatch skill.** One verified branch and 1-2 PRs per dependency-update run:
  risk-tiered batches on a dedicated branch, each gated with the repo's own build and
  test command, failures bisected so only the culprit is reverted, and a PR report of
  what was kept, reverted, skipped, and deliberately not taken.
- **A published adapter contract** (`docs/adapters.md`). Everything ecosystem-specific
  lives behind it: version bump classification, prerelease detection, grouping families,
  and the element ids that `apply` consumes. Core knows nothing about any ecosystem.
- **npm and Maven adapters**, each exposing `detect`, `discover`, `apply`, `revert`, and
  an `adapter.json` manifest.
- **A conformance suite** (`conformance/run.sh`). An adapter that passes it against a
  committed fixture is mergeable: detect, contract-valid and side-effect-free discover,
  a real apply, the mandatory exit-4 no-op check, and a revert that restores the tree
  byte-identically.
- **Fixtures** for both core ecosystems, with dependencies pinned deliberately behind
  their latest releases.
- **First-class headless mode.** Documented rules for running with no human present: a
  missing config aborts rather than inventing a gate, an over-budget plan proceeds and
  reports instead of asking, and every stop condition writes `.greenbatch/report.md` so
  a scheduled run always leaves an artifact.
- **Config at `greenbatch.yml`** in the repo root as well as `.claude/greenbatch.yml`,
  for agents that do not use a `.claude/` directory. `.claude/` takes precedence.
- **Report-only mode.** Without `gh`, the run still cuts the branch, verifies every
  batch, and commits what passed; it prints ready-to-paste PR bodies instead of filing
  them. `glab` is documented as an alternative for GitLab.
- CI on macOS and Ubuntu: shellcheck, unit tests, and conformance for both adapters.
- MIT license, DCO-based contribution flow, adapter contribution guide, and a security
  model stated as guarantees with pointers to the enforcing code.

### Changed from the internal version

- Grouping heuristics (shared npm scope, `pkg` ↔ `@types/pkg`) moved out of the planner
  and into the npm adapter, expressed as an adapter-supplied `family` string. The
  planner unions families and no longer knows what a scope is.
- `bump` and `prerelease` are reported by the adapter, which knows its own versioning
  scheme. The planner's semver helpers remain only as a fallback for adapters that omit
  them; anything unparseable or `unknown` still stays out of tier 1.
- `apply` takes adapter-owned element ids carried in the facts JSON, rather than having
  core construct Maven specs from a mechanism field. `mechanism` is now genuinely
  opaque to core.
- Parent POM bumps are flagged `risky: true` by the Maven adapter instead of being
  recognised by core through a mechanism check. Tiering behaviour is unchanged.
- The Maven adapter skips `display-parent-updates` on a pom with no `<parent>`, so
  single-module projects discover cleanly.
- The Slack reporting step was removed. The report on stdout and in
  `.greenbatch/report.md` is the only output; wire your own notifications around a run.

[Unreleased]: https://github.com/OWNER/greenbatch/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/greenbatch/releases/tag/v0.1.0
