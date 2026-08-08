# The adapter contract

**Status: normative.** An adapter that satisfies everything on this page and passes
`conformance/run.sh` is mergeable. An adapter that does not is not, however useful it
looks.

Core knows nothing about any ecosystem. It does not know what a version number means,
which packages are released together, or how to edit a manifest. All of that lives in
an adapter, and the two sides meet at one JSON document.

```
scripts/adapters/<ecosystem>/
  adapter.json     manifest: detection files, required tools, capabilities
  detect           does this adapter apply to this repo?
  discover         what updates are available?  -> facts JSON
  apply            move these element ids
  revert           put the tree back
```

The four scripts have no file extension on purpose: the contract is about arguments,
stdout, and exit codes, not about implementation language. Write yours in bash, Python,
Go, or anything else that can be marked executable.

## The four scripts

Every script takes the repo directory as its first argument and must work when that
directory is not the current one.

### `detect [repo-dir]`

Exit `0` if this adapter applies to the repo, `1` if it does not. No output.

Keep it to a file test. The orchestrator (`scripts/core/detect.sh`) runs every installed
adapter's `detect` on every run, so anything that touches the network or the build
system here is a cost the whole run pays.

A `detect` that returns 0 for any directory fails conformance.

### `discover [repo-dir]`

Prints facts JSON (below) on stdout. Exit `0` on success - an empty `updates` list is
success, not failure. Exit `2` on tool failure, with a diagnosis on stderr.

**`discover` must be side-effect free.** It may read the manifest and query a registry;
it must not write to the working tree. The run re-discovers *after* cutting the deps
branch, precisely so the facts describe the tree being built, and a `discover` that
edits the tree would corrupt the thing it is describing. Conformance asserts the
working tree is unchanged afterwards.

Keep it cheap for the same reason: it runs at least once per run, on every detected
ecosystem, before any useful work has happened.

### `apply <repo-dir> <element-id>...`

Applies the named elements. Prints whatever record of what landed the adapter can
produce (npm prints `{"applied":[...]}`); core reports from it rather than from the
plan, so the PR body quotes reality.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Applied. The manifest changed. |
| `2` | Tool failure, or an element id this adapter cannot parse. |
| `4` | **Nothing changed.** |

**Exit 4 is the load-bearing one.** A filter that matches nothing typically leaves the
manifest untouched while the underlying tool still exits 0. Without this check the run
commits an empty change and reports an update that never happened. So: hash the manifest
before and after (`git hash-object`), and exit 4 when they match. A no-op apply is a
detectable error, never a committable success. Core treats exit 4 as a bug in the
element list and never commits the result.

`apply` must pin the exact version the element id names rather than re-resolving
"latest", so that what lands is what was planned and reported even if a release happens
mid-run.

### `revert [repo-dir]`

Restores the manifests **and** any lockfiles to git HEAD, then reinstalls so the
installed tree matches what the manifest now says. Without the reinstall, the next gate
runs against the tree the failed batch left behind and the result is meaningless.

An ecosystem with no lockfile and no install step (Maven) satisfies "the tree matches"
by restoring the poms alone.

Conformance asserts the fixture is byte-identical to git HEAD afterwards.

## Facts JSON

The output of `discover`, and the entire adapter-to-core interface.

```json
{
  "ecosystem": "npm",
  "capabilities": ["lockfile", "audit"],
  "updates": [
    {
      "id": "zod",
      "name": "zod",
      "from": "3.22.0",
      "to": "3.24.0",
      "bump": "minor",
      "prerelease": false,
      "mechanism": "npm",
      "family": null
    }
  ],
  "unmanageable": []
}
```

### Top level

| Field | Required | Meaning |
|---|---|---|
| `ecosystem` | yes | The adapter's name. Also scopes `family`, so two adapters cannot collide on a family name. |
| `updates` | yes | Everything this run could move. May be empty. |
| `unmanageable` | **yes** | Everything it could not. May be empty, but the key must be present. |
| `capabilities` | no | What this ecosystem supports. Core budgets a gate run for the transitive pass when `audit` is present. |

### An update

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | The element id. Core stores it and hands it back to `apply` verbatim. |
| `name` | yes | What a human calls this. Matched against config `groups`, `risky`, and `reject`. |
| `from`, `to` | yes | Versions as the manifest and the registry state them. |
| `mechanism` | yes | Opaque, adapter-owned. Core stores and reports it; only the adapter interprets it. |
| `bump` | no | `patch` \| `minor` \| `major` \| `unknown`. |
| `prerelease` | no | Boolean. |
| `family` | no | Grouping key, or null. |
| `risky` | no | Boolean. Force this update to tier 2 regardless of its bump. |

Adapters may add their own fields (the Maven adapter carries `artifacts`); core passes
anything it does not recognise through to the report untouched.

### `id` and `mechanism`

The element id is the adapter's private business. npm's is simply the package name.
Maven's encodes the lever along with the coordinate and the target version:

```
property:springdoc.version=3.1.0
dependency:org.postgresql:postgresql=42.7.13
parent=4.2.0
```

Core never constructs, parses, or edits an id. It copies ids out of the facts and hands
them back. That is what keeps `mechanism` genuinely opaque: Maven's three levers
(property, dependency, parent) mean something only inside the Maven adapter, and
applying the wrong one changes nothing and exits 0 - which is exactly the failure exit 4
exists to catch.

Entries in `unmanageable` carry **no** `id`, because there is nothing to apply.

### `bump` and `prerelease`

Version semantics belong to the ecosystem, so the adapter classifies them. Core only
falls back to `semverBump()` / `isPrerelease()` in `plan.mjs` when the adapter omits the
field, and that fallback assumes plain three-component semver - which npm has, PEP 440
does not, Maven qualifiers do not, and Go pseudo-versions do not.

Report `bump` honestly:

- Anything you cannot classify is `"unknown"`, never a guess at `patch`.
- `"unknown"`, and any value core does not recognise, stays out of tier 1. This is the
  conservative rule and it is deliberate: an unrecognisable version shape must never be
  batched with 40 other updates and committed on one green gate.

Report `prerelease: true` for anything an RC, alpha, beta, milestone, snapshot, or
canary. Core never applies a prerelease and always reports it as available-but-not-taken.
Adopting one is a human decision.

### `family`

An optional grouping key. Core unions every update sharing a family (within one
ecosystem) into a single **atomic element**: they apply together, gate together, commit
together, and if the gate fails they revert together. The bisect never splits inside
one, and the element's tier is the highest tier of any member.

Use it for relationships that make packages genuinely inseparable, not for cosmetic
batching. The npm adapter emits two:

- packages sharing a scope (`@example-ui/core`, `@example-ui/hooks`), because a scope is
  released in lockstep. `@types` is deliberately excluded: it is a namespace of
  unrelated stubs, so scope-grouping it would make one failure revert every unrelated
  stub.
- `pkg` and `@types/pkg`, because a types stub is meaningless apart from the package it
  describes.

A family of one is not a family. Emit `null` rather than naming a lone package after its
scope: core would print `@playwright` in the PR table where `@playwright/test` is what
the reader needs. Core guards against this too, but the adapter should not rely on that.

Cross-ecosystem grouping is not an adapter's business. The config's `groups` key is the
only rule that crosses ecosystems, and core owns it.

### `risky`

Set `risky: true` when an update's blast radius has nothing to do with how small its
version step looks. The Maven adapter sets it on parent POM bumps: `4.1.0 → 4.1.1` is a
patch by any reading, but it moves a whole managed version set at once, so it must never
ride along in the tier-1 batch. Reporting it as a fake `major` would put a wrong number
in the PR table; `risky` keeps the report honest and the tiering correct.

Core unions this with the config's `risky` list.

### `unmanageable`

Updates that exist but that this run has no lever to make. The canonical case is a Maven
dependency whose version comes from the parent or an imported BOM: moving it would mean
overriding the parent's tested version set, so it moves when the parent moves.

```json
{
  "name": "org.postgresql:postgresql",
  "from": "42.7.11",
  "to": "42.7.13",
  "reason": "version managed by the parent or an imported BOM - moves when the parent moves"
}
```

**Reporting these is mandatory.** `name`, `from`, `to`, and `reason` are all required,
and `reason` has to be specific enough for a reader to act on. An adapter that silently
drops what it cannot move makes the PR body say "everything is current" when it is not,
and that is the one wrong impression this tool must never leave.

## `adapter.json`

```json
{
  "name": "npm",
  "description": "npm / Node.js packages declared in package.json, resolved through npm-check-updates.",
  "status": "core",
  "detect": { "files": ["package.json"] },
  "manifests": ["package.json"],
  "lockfiles": ["package-lock.json"],
  "requires": ["node", "npm", "git"],
  "capabilities": ["lockfile", "audit", "family", "bump", "prerelease"],
  "conformance": { "unmatchedId": "greenbatch-no-such-package-9f3a1c" }
}
```

`requires` lists the executables the adapter needs on PATH; conformance skips (or, with
`--strict`, fails) when one is missing, instead of reporting a confusing failure.

`conformance.unmatchedId` is a syntactically valid element id that is guaranteed to
match nothing. Conformance applies it and requires exit 4. Only the adapter knows its
own id syntax, so only the adapter can supply this.

`status` is `core` or `community`; see CONTRIBUTING.md.

## Portability

The scripts must run unmodified on macOS and Linux, on a developer laptop and a CI
runner:

- **No GNU-only tools.** In particular no `timeout` - it does not exist on macOS. If you
  need a bound on a subprocess, redesign rather than reach for it.
- No non-POSIX flags on `sed`, `grep`, `date`, or `find`.
- `shellcheck` clean, for anything written in shell.

## Getting an adapter merged

1. Create `scripts/adapters/<ecosystem>/` with the four scripts and `adapter.json`.
2. Add `fixtures/<ecosystem>-basic/`: the smallest real project in that ecosystem, with
   at least one dependency pinned deliberately behind its latest release, committed to
   this repo. Conformance grades `revert` against git HEAD, so an uncommitted fixture
   cannot be graded.
3. `conformance/run.sh <ecosystem> fixtures/<ecosystem>-basic` passes.
4. Add both to the CI matrix in `.github/workflows/ci.yml`.
5. Unit-test whatever version and grouping logic you wrote, the way
   `skills/greenbatch/tests/npm-rules.test.mjs` does. These rules decide what gets
   batched together and what never enters tier 1; both are invisible when wrong.

While developing, validate your output directly:

```bash
skills/greenbatch/scripts/adapters/<ecosystem>/discover . > facts.json
node conformance/validate-facts.mjs facts.json
```
