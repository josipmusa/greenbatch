# Contributing

Adapters are the most useful thing you can contribute, and the contract is written down
so that a good adapter is mergeable without a design debate. Start at
[docs/adapters.md](docs/adapters.md).

## Developer Certificate of Origin

Contributions are accepted under the [DCO](https://developercertificate.org/). Sign off
every commit:

```bash
git commit -s -m "npm: keep a lone scoped package out of a family"
```

`-s` appends the trailer that says you have the right to submit the work:

```
Signed-off-by: Your Name <you@example.com>
```

No CLA. Everything is MIT.

## Running the checks

```bash
# Unit tests
node --test skills/greenbatch/tests/*.test.mjs

# Shell lint (everything, including the extensionless adapter scripts)
shellcheck skills/greenbatch/scripts/core/*.sh conformance/run.sh \
           skills/greenbatch/scripts/adapters/*/{detect,discover,apply,revert}

# Adapter conformance
conformance/run.sh npm   fixtures/npm-basic
conformance/run.sh maven fixtures/maven-basic
```

Pass the tests as a glob rather than as a directory: `node --test <dir>` is broken in the
Node 22 line and fails to resolve the directory. The glob form works everywhere.

Conformance skips an adapter whose tools are not installed. CI passes `--strict` so a
runner that quietly lost its JDK cannot report a green suite; use `--strict` locally when
you want the same.

## Contributing an adapter

An adapter is mergeable when it satisfies [docs/adapters.md](docs/adapters.md) and
`conformance/run.sh` passes. That is the whole bar - no separate approval of the design.

1. `skills/greenbatch/scripts/adapters/<ecosystem>/` with `detect`, `discover`, `apply`,
   `revert`, and `adapter.json`.
2. `fixtures/<ecosystem>-basic/`: the smallest real project in that ecosystem with at
   least one dependency pinned deliberately behind its latest release. It must be
   committed - conformance grades `revert` against git HEAD.
3. Unit tests for whatever version and grouping logic you wrote. See
   `skills/greenbatch/tests/npm-rules.test.mjs`. These rules decide what gets batched
   together and what never enters tier 1, and both are invisible when wrong.
4. Add the ecosystem to the CI matrix in `.github/workflows/ci.yml`.
5. Add a row to the README's ecosystem list.

Things reviewers will check, because they are the mistakes that cost the most later:

- `apply` exits **4** when nothing changed, verified with a before/after manifest hash.
- `discover` writes nothing to the working tree.
- `unmanageable` is present and populated - anything you cannot move is reported, never
  dropped.
- `bump` is `"unknown"` where you are unsure, never a guess at `patch`.
- No GNU-only tools. `timeout` in particular does not exist on macOS.

### Core vs community adapters

**Core** adapters (npm, Maven) are maintained here, covered by CI on every push, and
release-blocking: a red conformance run blocks the release.

**Community** adapters live in the same tree with `"status": "community"` in
`adapter.json`. They run in CI too, but a break is a bug against the adapter rather than
a release blocker, and the maintainer listed in the manifest gets pinged first. An
adapter graduates to core once it has a maintainer who responds and a few releases of
green CI behind it.

## Roadmap

**Wanted next** - these have real batch-verify-bisect value and no good alternative:

- **Python** (uv, pip)
- **Go** (`go get -u`, `go mod tidy`)
- **Rust** (`cargo update`)

**After that:** Gradle, Composer, Ruby (Bundler), NuGet.

**Explicitly out of scope:** Docker, GitHub Actions, and Terraform. Dependabot and
Renovate handle those well, none of them has a meaningful local gate to batch against,
and greenbatch is better as the tool you point at your application dependencies while
Dependabot keeps the rest.

Other ideas on the list:

- Workspace and monorepo support (multiple manifests per repo). The largest known gap.
- Notification hooks - a possible future addition, deliberately absent for now.

## Reporting bugs

Include the report file (`.greenbatch/report.md`) if the run produced one, the plan JSON,
and the tail of the relevant gate log. A run that misreported something is a more serious
bug than a run that failed, so say clearly which one you hit.
