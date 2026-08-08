# Security

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** button on the Security tab,
rather than in a public issue. Expect an acknowledgement within a few days.

## What greenbatch does to your repository

greenbatch changes dependency manifests, and it runs your build. Both matter, so both are
stated here.

### Guarantees

greenbatch is an agent following a written procedure, using deterministic scripts for
the mechanical parts. Some rules below are enforced by a script that refuses; the rest
are part of the procedure in `skills/greenbatch/SKILL.md`. The distinction is real, so
it is stated rather than blurred - all of it is worth checking against the source before
you trust it.

**Enforced by a script:**

- **Never force-pushes**, ever, to anything, and **only pushes branches it created**,
  named `deps/YYYY-MM-DD` or `deps/YYYY-MM-DD-<target>` - so never your base branch or
  any target branch. `scripts/core/push.sh` is the only thing in the tool that mutates a
  remote, and it rejects anything else, including a refspec or a flag smuggled in as a
  branch name.
- **Never deletes a branch it did not create.** Closing superseded PRs requires both a
  dated branch name and this tool's marker in the PR body.
- **Never commits a change that did not happen.** An apply that leaves the manifest
  byte-identical exits 4 and is treated as an error, not a success.
- **Never applies a version it did not discover and report.** The target version is part
  of the element id, and the conformance suite compares what actually landed in the
  manifest against what discovery offered.
- **Never acts on a config it did not understand.** `scripts/core/config.mjs` rejects an
  unknown key or a wrong type with a line number instead of falling back to defaults,
  and there is no default gate.

**Part of the run procedure:**

- **Never merges a pull request.** It opens them and stops.
- **Never runs `npm audit fix --force`.** That flag takes major versions without gating
  them, which is precisely the thing this tool exists to avoid.
- **Never edits source code** to make a breaking change fit. Breaking changes are
  reported with what they break in your repo; the decision is yours.
- **Aborts on a dirty working tree** rather than stashing or committing your work.
- **Aborts if your gate fails on the clean branch**, before touching a manifest.
- **Restores your original branch on every exit path**, including aborts and crashes,
  and reinstalls so your working tree matches the branch it hands back.

### What it executes

- **Your gate command**, repeatedly. That is the point, and it is your command from your
  config file.
- **Package manager install steps**, which for npm means running whatever lifecycle
  scripts the packages being installed define. This is the same exposure as running
  `npm install` yourself, and it happens on a branch with updated dependencies - so
  **a compromised release of a dependency you already use will execute during a run.**
  greenbatch does not sandbox this and does not claim to. If that exposure matters to
  you, run it in a container or a disposable CI runner rather than on a developer laptop.
- **`mvn` goals** from the versions plugin, which resolve artifacts from your configured
  repositories.

Third-party tooling is pinned rather than floating: `npm-check-updates` to its major
line (override with `NCU_SPEC`) and the versions-maven-plugin to an exact version
(`VERSIONS_PLUGIN`). A discovery tool that silently changed major version between two
scheduled runs could change what the report says without anything in your repository
having changed.

It does not execute anything from the updates' changelogs or release notes; those are
read as text.

### Network and credentials

- Package registries, for version resolution.
- The GitHub API through `gh`, using your existing credentials, for Dependabot alerts and
  for opening PRs. Without `gh` the run finishes and prints ready-to-paste PR bodies
  instead.
- Project changelogs and release pages, fetched to inform the tier-2 decisions.

greenbatch needs no credentials of its own beyond git push access for `deps/*` branches
and whatever `gh` is already authenticated with. It stores nothing.

### A note on trust in the report

The report is the product. If greenbatch ever claims an update was verified when it was
not - a version in the table that was never applied, a gate reported green that did not
run - that is a security-relevant bug even though nothing crashed, and it is worth
reporting as one. Several parts of the design exist only to prevent it: the exit-4 no-op
check, applying the exact discovered version rather than re-resolving latest, reporting
what actually landed rather than what was planned, and re-discovering after the branch is
cut.

## Supported versions

greenbatch is pre-1.0. Fixes land on the latest release only.
