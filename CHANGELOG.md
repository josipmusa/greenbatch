# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org/); greenbatch
is pre-1.0, so the minor version moves for breaking changes.

## Unreleased

### Fixed

- **Maven: a prerelease no longer hides the stable release behind it.** The versions
  plugin offers exactly one newest version, so an alpha replaced the answer rather than
  adding to it. On this repository's own fixture, `slf4j-api` reported
  `2.0.0 -> 2.1.0-alpha1` - correctly flagged as a prerelease and correctly never
  applied - while stable `2.0.18` went unmentioned, and the report read as "nothing to
  take here". Discovery now filters prereleases at the source.
- **npm no longer claims repositories another package manager owns.** `detect` was a
  bare "is there a `package.json`" test, so a pnpm, yarn, or bun project was claimed,
  `npm install`ed, and left with a stray `package-lock.json` that `revert` could not
  restore because git had never seen it.
- **npm applies the version that was discovered, planned, and reported.** `apply` used
  to re-run `npm-check-updates`, which resolves `latest` at apply time: a release
  published between discovery and apply entered the tier-1 batch with its changelog
  unread. The element id now carries the version, and conformance checks that what
  landed in the manifest is what discovery offered.
- **Multi-module Maven no longer fabricates `unmanageable` entries.** The version goals
  ran over the whole reactor while only the root pom was parsed to resolve levers, so
  every child-module dependency looked version-less and was reported as "pinned by a
  parent or BOM". Discovery now scans the root pom only and reports the modules it
  skipped.
- **An unreadable repo directory no longer stops a run.** `alerts.sh` exited 0 with
  empty stdout instead of `[]`, and `plan.mjs` died on `Unexpected end of JSON input`
  over an enrichment that is allowed to be missing.
- `revert` restores from `HEAD` rather than the index in both adapters, so a change the
  run had already staged cannot survive a revert and ride into the next batch as though
  it had passed the gate.
- Maven `revert` no longer expands an empty pom list into a whole-tree checkout.
- Config groups joined by a shared package merge under a name that names both, instead
  of whichever group happened to come first in the file.
- The gate estimate counts the re-gate each derived target branch needs.

### Added

- **`/greenbatch`** - the command actually exists now. It was documented in the README
  and every headless example as `/greenbatch run`, with no `commands/` directory behind
  it.
- **`/greenbatch plan`** - plan-only mode. Discovers, tiers, and reports what a full run
  would do, without cutting a branch, applying anything, running the gate, pushing, or
  opening a PR. Safe on a dirty tree.
- **`scripts/core/config.mjs`** - finds, validates, and normalizes the config. An
  unknown key is an error naming the line and the key you probably meant, rather than a
  silent fallback: `rejects:` for `reject:` used to mean a package you had deliberately
  pinned got updated with nothing in the report about it.
- **`scripts/core/push.sh`** - the only script that mutates a remote. Refuses any ref
  that is not a `deps/YYYY-MM-DD[-target]` branch, refuses force refspecs, and pushes by
  explicit refspec.
- **Conformance stages** for version pinning, declared detection decoys
  (`conformance.rejectFixtures`), and an optional post-apply fixture gate
  (`conformance.gate`). All three blockers above existed because nothing checked the
  property they violated.
- **`notes`** in the facts contract: caveats about what discovery did *not* look at, as
  distinct from `unmanageable`, which is about updates it cannot move. Carried into the
  report and the PR body.
- `plan.mjs --help`, and argument errors that name the flag instead of surfacing a stack
  trace about Node internals.

### Changed

- **The run report moves to `.git/greenbatch/report.md`.** git never tracks anything
  under `.git/`, so the report no longer requires editing your `.gitignore` and never
  appears in `git status`.
- **Stale-PR cleanup is narrower.** Closing a PR and deleting its branch now requires
  both a dated branch name and this tool's marker in the PR body. A `deps/*` glob alone
  matched a human's `deps/fix-lockfile`, and this is the only destructive thing a run
  does.
- **`apply`'s output record is normative.** One entry per element id, with `to` read
  back out of the manifest rather than echoed from the id.
- **`docs/headless.md` is about headless Claude Code sessions**, on a workstation,
  server, or cloud VM, with cron and systemd examples. The GitHub Actions workflow is
  gone: PRs opened with a default CI token do not trigger workflows, so the sample
  produced PRs with no CI on them, and its `security-events: read` permission did not
  actually grant access to Dependabot alerts.
- **The README safety table is split** into rules a script enforces and rules the run
  procedure follows. It previously said each row pointed at the code enforcing it while
  eight of ten pointed at prose.
- Third-party tooling is pinned: `npm-check-updates` to its major line (`NCU_SPEC`), the
  versions-maven-plugin to an exact version (`VERSIONS_PLUGIN`).
- npm element ids are now `name@version`; Maven ids are unchanged.

## 0.1.0

Initial release: npm and Maven adapters, the tiered plan, the conformance suite, and the
skill.
