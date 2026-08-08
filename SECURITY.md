# Security

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** button on the Security tab,
rather than in a public issue. Expect an acknowledgement within a few days.

## What greenbatch does to your repository

greenbatch changes dependency manifests, and it runs your build. Both matter, so both are
stated here.

### Guarantees

These are enforced by the run procedure in `skills/greenbatch/SKILL.md`. They are
worth checking against the source before you trust them.

- **Never force-pushes**, ever, to anything.
- **Only pushes branches it created**, named `deps/*`.
- **Never pushes to your base branch or any target branch.**
- **Never merges a pull request.** It opens them and stops.
- **Never runs `npm audit fix --force`.** That flag takes major versions without gating
  them, which is precisely the thing this tool exists to avoid.
- **Never edits source code** to make a breaking change fit. Breaking changes are
  reported with what they break in your repo; the decision is yours.
- **Aborts on a dirty working tree** rather than stashing or committing your work.
- **Aborts if your gate fails on the clean branch**, before touching a manifest.
- **Restores your original branch on every exit path**, including aborts and crashes,
  and reinstalls so your working tree matches the branch it hands back.
- **Never commits a change that did not happen.** An apply that leaves the manifest
  byte-identical exits 4 and is treated as an error, not a success.

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
