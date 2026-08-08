---
name: A run reported something untrue
about: The report claimed an update was verified, applied, or unavailable when it was not
title: 'misreport: '
labels: ['bug', 'misreport']
---

<!--
This is the most serious kind of bug in greenbatch, more serious than a crash. A
run that fails is obvious; a run that quietly says the wrong thing gets believed
and merged. Please file these even when you are not sure.
-->

## What the report said

<!-- Quote the line. A version in the table, a "kept" that was not kept, a
package listed as unavailable that was perfectly movable, a green gate. -->

## What was actually true

<!-- What the manifest, the lockfile, or the branch actually contained. -->

## The run

- greenbatch version:
- Ecosystem(s): <!-- npm / maven -->
- Interactive or headless:

Attach if you have them - `.git/greenbatch/report.md`, the plan JSON from `plan.mjs`,
and the tail of the relevant gate log. Redact anything private; the version numbers and
package names are usually all that matter.

## Anything else

<!-- Was the repo multi-module? A monorepo? Was the checkout behind its remote? -->
