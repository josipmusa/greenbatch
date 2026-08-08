# Design

Why greenbatch is shaped the way it is. If you are here to write an adapter, read
`adapters.md` instead - this page is the reasoning behind the parts that are easy to
"simplify" into being wrong.

## The problem

Dependabot opens one PR per update or group, and each one fires a full CI pipeline. A
repo with a six-minute pipeline and forty pending updates spends hours of CI to tell you
forty times that the tests still pass. With dual-branch repos (a `dev` and a `main` that
both take dependency PRs) the PR count and the CI time double, and the branches drift
apart while the PRs sit.

The work that actually matters is verification, and verification only has to happen
once - on a branch that carries all the updates that pass together.

## The approach

One run produces exactly one verified branch and one PR per target branch. Every commit
on that branch already passed the repo's own build-and-test gate locally, so the
expensive CI runs once, on a diff that is already known green.

The updates that do not pass are not on the branch. They are in the report, with the
gate output that killed them.

## Scripts do the mechanics, the model does the judgment

This is the core of the design and the thing most worth preserving.

**Deterministic scripts** own discovery, application, reverting, gating, alert fetching,
and the entire tier and group calculation. They take arguments, print JSON, and run fine
outside any agent. They are auditable, testable, and identical on every run.

**The model** owns the parts that are actually judgment: reading a changelog to decide
whether a major is attemptable or needs human migration, diagnosing why a gate failed,
resolving a lockfile conflict, and writing a PR body a human can trust without
re-running anything.

The split is not stylistic. Tier assignment and group resolution are mechanical
decisions over dozens of packages, and they are *invisible when wrong*: a group silently
split in two still produces a green run and a plausible report. Mechanical work that
fails silently belongs in code with tests around it. Meanwhile "does this major break
this repo" cannot be encoded in a script at all, and pretending otherwise produces
either a tool that never attempts majors or one that attempts all of them.

A run therefore never improvises a mechanical operation. If the scripts do not cover a
state - a merge conflict, an unusual repo layout - that is the moment for raw commands,
and only then.

## Tiers

- **Tier 1** - patch and minor updates, excluding anything the config calls `risky` and
  anything an adapter flagged `risky`.
- **Tier 2** - majors, `risky` packages, adapter-flagged risky updates (a parent POM
  bump), and anything whose bump could not be classified.

Tier 1 goes in as one batch with one gate run. If it passes, forty updates cost one gate
run. If it fails, the batch is bisected: split the element list in half, apply and gate
each half, recurse into whichever half fails. Passing halves commit; a failing leaf
reverts with its gate log kept.

Tier 2 is one element at a time, because a major that fails tells you nothing useful if
it failed alongside eleven others.

### The invariant: tier 1 is never starved

One `max_gate_runs` counter spans the whole run. **Tier 1 runs first and is guaranteed
enough budget to complete, bisect included. Only tier 2 and the transitive pass are
budget-capped.**

This is stated explicitly, in the spec and in SKILL.md, so that a later edit cannot
reorder it away by accident. The patch/minor batch is the highest-value, lowest-risk
work in the run. A repo with thirty pending majors must not spend its entire budget
attempting them one at a time and leave the safe updates untaken - which is exactly what
a naive "process the plan in order" implementation would do.

The plan reports `estimatedGateRuns` against `maxGateRuns` up front, so an over-budget
run is visible before an hour of gate time is spent rather than after. The estimate is a
floor: it counts one clean gate, one tier-1 batch, one run per tier-2 element, and one
transitive pass, and a tier-1 bisect adds runs beyond it. That is the honest direction
for a floor to be wrong in.

## Groups are atomic, not cosmetic

A group is one element. All members apply, gate, and commit together; on failure the
whole group reverts and reports as one row; and **the bisect never splits inside one**.

The reason is that the members are not independently valid. Half a UI kit's scope, or a
package updated without its types stub, is a state nobody tested and nobody wants
committed. Allowing the bisect to split a group would let it commit exactly that state
whenever it happened to land on a passing half.

A group's tier is the highest tier of any member, for the same reason: the group moves
as one thing, so it carries its riskiest member's risk.

Grouping rules come from two places. Adapters emit a `family` per update for
relationships their ecosystem makes inseparable (a shared npm scope, a package and its
types stub). The config's `groups` key is the only rule that crosses ecosystems, and
core owns it. Neither is a heuristic core invents.

## One element per lever

The Maven adapter emits one element per *lever*, not per artifact, and this is the
subtlety that costs the most time to rediscover.

The versions plugin's property and dependency reports overlap. A library whose version
is a `${property}` reference appears in both; one with a literal `<version>` tag appears
only in the dependency report. Property-controlled versions move only via
`set-property`; literals move only via `use-dep-version`. **Applying the wrong lever
changes nothing and exits 0.**

So the adapter parses the pom to resolve which lever controls each artifact, dedupes the
two reports accordingly, and encodes the lever into the element id. A version pinned by
the parent or an imported BOM has no lever at all, and goes to `unmanageable` rather
than being silently dropped.

## Exit 4: a no-op apply is an error

`apply` exits 4 when the manifest is byte-identical afterwards.

This exists because the underlying tools report success for a filter that matched
nothing. `ncu -u --filter <package-that-is-not-there>` exits 0. A Maven goal aimed at
the wrong lever exits 0. Without an explicit before/after hash, the run would commit an
empty change and put an update in the report that never happened - and the report is the
entire product.

So a no-op apply is a **detectable error, never a committable success**. Core treats
exit 4 as a bug in the element list, usually stale discovery, and re-plans rather than
hand-editing ids to route around it.

This is also why discovery happens *after* the deps branch is cut. Facts gathered on a
stale local branch describe a tree the run is not building: `from` versions are wrong,
and packages already updated on the real base show up as pending work. The symptom is a
plan that cannot apply and a PR body full of version numbers that were never true.

## The branch and PR model

**The deps branch is never contaminated with commits from another branch.**

`deps/YYYY-MM-DD` is cut from `origin/<base>` and stays a clean deps-only diff. It gets
pushed and opens a PR toward `base`, carrying the full report.

Every *other* target gets a derived branch `deps/YYYY-MM-DD-<target>`, cut from that
target with the deps branch merged into it, opening a PR toward that target with a short
body linking to the full one.

The alternative - cutting from `dev` and PRing to both - drags `dev`'s unreleased
commits into the main-bound PR. That turns a reviewable dependency diff into a release,
which is how dependency automation gets switched off.

Lockfile conflicts on a derived branch are resolved by taking the manifest merge and
regenerating, then re-running the gate on that branch. Any non-lockfile conflict is
*not* resolved: the run pushes what it has, opens the PR marked conflicted, and flags it
at the top of the body. Guessing at a source conflict is how automation loses trust.

## Configuration bootstrap

The first interactive run derives a config from `.github/dependabot.yml`, shows it, and
writes it only after approval.

Real atomic groups, `labels`, the commit prefix, and target branches transfer.
Dependabot's `dev-dependencies` and `minor-and-patch` groups are dropped: they are
PR-batching groups, and the tier system replaces them. Carrying them over would create
one enormous "group" that the bisect is forbidden to split - the exact opposite of what
atomicity is for.

`gate` cannot be derived and is never invented. It is guessed out loud and confirmed. A
gate missing the build step silently weakens every verification in the run, and the
whole value of the tool is that the gate was real. This is also why the bootstrap is
interactive-only and a headless run with no config aborts instead.

Once the config exists, `dependabot.yml` is never a config source again - no dual source
of truth. It is still read to check which ecosystems Dependabot still owns, so the PR
body can warn about duplicate PRs.

## What is deliberately not here

- **Auto-merge.** The tool opens PRs and stops.
- **Fixing code to accommodate a breaking change.** Reported as "needs human migration",
  with what breaks in *this* repo. A tool that edits source to make a major fit is a
  tool whose diffs need the same review the dependency update was trying to avoid.
- **Notifications.** The report on stdout and in `.greenbatch/report.md` is the output;
  wire your own around a headless run.
- **A forge abstraction.** GitHub via `gh`, and report-only mode everywhere else. `glab`
  takes the same PR body from the same file.
- **GitHub Actions, Docker, and Terraform ecosystems.** Dependabot and Renovate handle
  those well, and none of them has the batch-verify-bisect problem this tool exists to
  solve.
