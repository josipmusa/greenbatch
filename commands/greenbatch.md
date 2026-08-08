---
description: Run a verified dependency update - one branch, tiered batches, one PR per target
argument-hint: "[plan]"
---

Run greenbatch on the repository in the current working directory.

Follow the `greenbatch` skill (`skills/greenbatch/SKILL.md`) exactly. It is the
normative procedure; this command only chooses which mode to run in.

**Mode:** `$ARGUMENTS`

- Empty, or anything not listed below - **a full run.** The whole procedure:
  preflight, clean gate, discover, tier 1, tier 2, transitive pass, PRs, restore.
- `plan` - **plan only.** Stop after producing the plan. Do not cut a branch, do
  not apply anything, do not run the gate, do not push, do not open a PR. Read
  the config, detect ecosystems, run each adapter's `discover` on the working
  tree as it is, run `plan.mjs`, and report what a full run would do: the tier-1
  batch, the tier-2 order, everything available but not taken, any discovery
  notes, and the gate estimate against the budget. This is read-only and safe on
  a dirty tree, so say which branch the numbers describe - they are the current
  checkout, not `origin/<base>` as a real run would use.

If the mode argument is anything other than `plan` or empty, say what you read it
as and run the full procedure.
