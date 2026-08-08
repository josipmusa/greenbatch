<!--
Structure for the FULL report, which goes on the PR toward `branches.base`.
Derived-branch PRs get the short body at the bottom instead. The same content is
what `.greenbatch/report.md` carries, so a headless run leaves this behind even
when no PR was opened.

Fill every section from the run's actual records: the plan, the apply output, and
the saved gate logs. Never describe an update you did not verify against those
records - the point of this PR is that a human can trust the table without
re-running anything.

Drop a section entirely when it has no content. An empty "Reverted" heading reads
as an omission; no heading reads as "nothing was reverted", which is the truth.
-->

## Dependency update - <YYYY-MM-DD>

<One or two sentences: how many updates were kept, how many reverted or skipped,
and the single most important thing a reviewer should know. If a security alert
was resolved or a major needs migration, that is the headline - not the count.>

### Updates

| Package | From | To | Tier | Status |
|---|---|---|---|---|
| `@example-ui/*` (5) | 9.4.2 | 9.5.1 | 1 | kept |
| `react`, `react-dom`, `@types/react` | 18.3.1 | 19.2.0 | 2 | skipped - needs migration |
| `eslint` | 8.57.0 | 9.0.0 | 2 | reverted - gate failed |

<Group elements occupy one row, named as a group, with the member count or the
member list - never split a group across rows, because a group was applied,
gated, and reverted as one thing. Status is one of: kept, reverted, skipped, or
not attempted.>

### Security

<Which Dependabot alerts this PR resolves: severity, package, GHSA id, and the
version that fixes it. If a still-open alert is NOT resolved by this PR, say so
and why - an unmentioned alert looks like an oversight.

Omit this section when the run resolved nothing and no alerts are open.>

- Resolves **high** `brace-expansion` (GHSA-mh99-v99m-4gvg) via the lockfile audit pass - patched in 2.1.3.

### Reverted

<One subsection per reverted element. The gate output trimmed to the part that
explains the failure - not the whole log - plus a one-line diagnosis when the
cause is evident from it. If the cause is not evident, say that rather than
guessing; a wrong diagnosis is worse than none.>

#### `eslint` 8.57.0 → 9.0.0

```
<the 5-20 relevant lines from the gate log>
```

Flat config is now required; `.eslintrc.cjs` is ignored.

### Needs human migration

<One subsection per skipped major, from the changelog read before it was
attempted. This is the TODO list, so be concrete about what must change in THIS
repo, not just what the library changed.>

#### `react` 18.3.1 → 19.2.0

<What breaks, and the migration this repo specifically needs.>

### Not attempted

<Only when the gate budget ran out. List the elements by name so the next run is
known to pick them up, and give the budget number that stopped it. A headless run
that started over budget says so here and at the top.>

### Available but not taken

<Updates the run deliberately did not apply. Say so explicitly: staying silent
here reads as "everything is current", which is the one wrong impression this
report must not leave. Three kinds, from the plan's `prerelease`, `unmanageable`,
and `rejected` lists - omit whichever is empty:

- **Prereleases.** A newer version exists but it is an RC/alpha/beta. Adopting a
  prerelease is a deliberate human call, so the run never does it.
- **No lever.** A version pinned by a parent or an imported BOM. Moving it would
  mean overriding the parent's tested version set, so it moves when the parent
  moves - not here.
- **Rejected.** Matched the config's `reject` list, an intentional pin.>

- `jackson-annotations` 2.22 → **3.0-rc5** - prerelease, not adopted automatically.
- `org.postgresql:postgresql` 42.7.11 → 42.7.13 - pinned by the parent POM; moves when the parent moves.
- `react-router` 6.1.0 → 7.0.0 - on the reject list.

### Run cost

<Gate runs used out of the budget, and total gate time. This is what per-repo
`max_gate_runs` tuning is based on, so keep it factual and always include it.>

- 7 gate runs of a 30 budget, 18m 40s of gate time total.

### Notes

<Only what applies. Omit the section when none of it does.>

- Superseded and closed <#PR> from a previous run; its updates were rediscovered here.
- `.claude/greenbatch.yml` was generated from `.github/dependabot.yml` in this PR.
- Dependabot still has `npm` enabled in `.github/dependabot.yml` - remove that block to stop duplicate PRs.
- Lockfile conflict on merge into `dev` was resolved by regenerating; the gate was re-run green on the derived branch.
- A root `greenbatch.yml` exists but `.claude/greenbatch.yml` took precedence.

---

<!--
SHORT body for derived-branch PRs (deps/<date>-<target> -> <target>). These carry
the same commits, so the full report is not repeated - it is linked. What does
belong here is anything true of THIS branch only: conflict resolution, and a
re-run gate result.
-->

## Dependency update - <YYYY-MM-DD> (→ `<target>`)

Carries the verified dependency updates from #<base PR number> onto `<target>`.
See that PR for the full report: what was kept, reverted, and skipped, and why.

**This branch:** <how the merge went. "Merged cleanly, gate re-run green." or the
conflict story: what conflicted, that lockfile conflicts were resolved by
regenerating, and the re-run gate result. If a non-lockfile conflict is
unresolved, say so plainly at the top - this PR needs a human before it merges.>
