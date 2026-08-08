import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildPlan } from '../scripts/core/plan.mjs'

// Facts as an adapter would emit them. `family` is what makes two updates one
// atomic element; core never derives it, so the tests state it explicitly.
const npm = (name, from, to, extra = {}) => ({
  ecosystem: 'npm',
  name,
  from,
  to,
  mechanism: 'npm',
  ...extra,
})

const emptyConfig = { groups: {}, risky: [], reject: [], maxGateRuns: 30 }
const config = (over = {}) => ({ ...emptyConfig, ...over })

const keys = (elements) => elements.map((e) => e.key).sort()
const find = (plan, key) => [...plan.tier1, ...plan.tier2].find((e) => e.key === key)

// ------------------------------------------------------------------ tiers

test('patch and minor updates land in tier 1, majors in tier 2', () => {
  const plan = buildPlan({
    updates: [
      npm('postcss', '8.4.1', '8.4.2'),
      npm('zod', '3.22.0', '3.24.0'),
      npm('eslint', '8.57.0', '9.0.0'),
    ],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), ['pkg:postcss', 'pkg:zod'])
  assert.deepEqual(keys(plan.tier2), ['pkg:eslint'])
})

test('risky packages go to tier 2 even for a patch bump', () => {
  const plan = buildPlan({
    updates: [npm('tailwindcss', '3.4.1', '3.4.2')],
    config: config({ risky: ['tailwindcss'] }),
  })

  assert.deepEqual(keys(plan.tier1), [])
  assert.deepEqual(keys(plan.tier2), ['pkg:tailwindcss'])
})

test('rejected packages are excluded from both tiers and reported', () => {
  const plan = buildPlan({
    updates: [npm('react-router', '6.1.0', '7.0.0'), npm('zod', '3.22.0', '3.24.0')],
    config: config({ reject: ['react-router'] }),
  })

  assert.deepEqual(keys(plan.tier1), ['pkg:zod'])
  assert.deepEqual(keys(plan.tier2), [])
  assert.deepEqual(
    plan.rejected.map((r) => r.name),
    ['react-router'],
  )
})

test('reject supports glob patterns', () => {
  const plan = buildPlan({
    updates: [npm('@acme/config', '1.0.0', '1.1.0'), npm('zod', '3.22.0', '3.24.0')],
    config: config({ reject: ['@acme/*'] }),
  })

  assert.deepEqual(keys(plan.tier1), ['pkg:zod'])
  assert.deepEqual(
    plan.rejected.map((r) => r.name),
    ['@acme/config'],
  )
})

test('an unparseable version bump is treated as major, not silently tier 1', () => {
  // No adapter-supplied bump, so the core fallback classifies it - and an
  // unrecognisable version shape must never open the tier-1 batch.
  const plan = buildPlan({
    updates: [npm('weird-pkg', 'nightly', 'latest')],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier2), ['pkg:weird-pkg'])
})

// ------------------------------------- adapter-supplied bump and prerelease

test('an adapter-supplied bump is used instead of the semver fallback', () => {
  // Maven's 2.22 -> 2.23 is a minor bump in its own scheme, but has no third
  // component, so the semver fallback alone would call it major.
  const plan = buildPlan({
    updates: [
      {
        ecosystem: 'maven',
        name: 'jackson.version',
        from: '2.22',
        to: '2.23',
        bump: 'minor',
        prerelease: false,
        mechanism: 'property',
      },
    ],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), ['pkg:jackson.version'])
})

test('core falls back to semver when the adapter omits bump', () => {
  const plan = buildPlan({
    updates: [npm('zod', '3.22.0', '4.0.0'), npm('postcss', '8.4.1', '8.4.2')],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), ['pkg:postcss'])
  assert.deepEqual(keys(plan.tier2), ['pkg:zod'])
})

test('an adapter-supplied bump of "unknown" stays out of tier 1', () => {
  const plan = buildPlan({
    updates: [npm('mystery', '1.x', '2.x', { bump: 'unknown' })],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), [])
  assert.deepEqual(keys(plan.tier2), ['pkg:mystery'])
})

test('a bump value core does not recognise is treated as unknown, not as small', () => {
  // A typo or a newer contract revision in an adapter must fail conservatively.
  const plan = buildPlan({
    updates: [npm('typo-pkg', '1.0.0', '1.0.1', { bump: 'pathc' })],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), [])
  assert.deepEqual(keys(plan.tier2), ['pkg:typo-pkg'])
})

test('an adapter-supplied prerelease flag overrides the core heuristic', () => {
  // ".Final" is a Hibernate-style release qualifier, and "2024.1" is a calendar
  // version - only the adapter can know which of the two is shippable.
  const plan = buildPlan({
    updates: [
      npm('release-qualified', '5.6.14', '5.6.15.Final', { bump: 'patch', prerelease: false }),
      npm('looks-stable', '1.0.0', '1.1.0', { bump: 'minor', prerelease: true }),
    ],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), ['pkg:release-qualified'])
  assert.deepEqual(
    plan.prerelease.map((u) => u.name),
    ['looks-stable'],
  )
})

test('core falls back to its own prerelease heuristic when the adapter omits it', () => {
  const plan = buildPlan({
    updates: [npm('safe-pkg', '1.2.3', '1.2.4'), npm('rc-pkg', '1.2.3', '1.3.0-rc1')],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), ['pkg:safe-pkg'])
  assert.deepEqual(
    plan.prerelease.map((u) => u.name),
    ['rc-pkg'],
  )
})

test('an adapter can flag an update risky whatever its bump says', () => {
  // A parent POM bump moves a whole managed version set at once, so its blast
  // radius has nothing to do with how small the version step looks.
  const plan = buildPlan({
    updates: [
      {
        ecosystem: 'maven',
        name: 'org.example.platform:platform-parent',
        from: '4.1.0',
        to: '4.1.1',
        bump: 'patch',
        prerelease: false,
        risky: true,
        mechanism: 'parent',
      },
    ],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), [])
  assert.deepEqual(keys(plan.tier2), ['pkg:org.example.platform:platform-parent'])
})

// ------------------------------------------------------------- grouping

test('an explicit config group becomes one atomic element', () => {
  const plan = buildPlan({
    updates: [
      npm('react', '18.3.1', '18.3.2'),
      npm('react-dom', '18.3.1', '18.3.2'),
      npm('@types/react', '18.3.1', '18.3.2'),
    ],
    config: config({ groups: { react: ['react', 'react-dom', '@types/react'] } }),
  })

  assert.deepEqual(keys(plan.tier1), ['group:react'])
  assert.deepEqual(
    find(plan, 'group:react')
      .members.map((m) => m.name)
      .sort(),
    ['@types/react', 'react', 'react-dom'],
  )
})

test("a group's tier is the highest tier of any member", () => {
  const plan = buildPlan({
    updates: [
      npm('react', '18.3.1', '18.3.2'), // patch
      npm('react-dom', '18.3.1', '19.0.0'), // major -> drags the group to tier 2
    ],
    config: config({ groups: { react: ['react', 'react-dom'] } }),
  })

  assert.deepEqual(keys(plan.tier1), [])
  assert.deepEqual(keys(plan.tier2), ['group:react'])
  assert.equal(find(plan, 'group:react').members.length, 2)
})

test('a group only contains the members that actually have updates', () => {
  const plan = buildPlan({
    updates: [npm('react', '18.3.1', '18.3.2')],
    config: config({ groups: { react: ['react', 'react-dom', '@types/react'] } }),
  })

  assert.deepEqual(
    find(plan, 'group:react').members.map((m) => m.name),
    ['react'],
  )
})

test('updates sharing an adapter family become one atomic element', () => {
  const plan = buildPlan({
    updates: [
      npm('@mantine/core', '9.4.2', '9.5.1', { family: '@mantine' }),
      npm('@mantine/hooks', '9.4.2', '9.5.1', { family: '@mantine' }),
      npm('@mantine/form', '9.4.2', '9.5.1', { family: '@mantine' }),
    ],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), ['group:@mantine'])
  assert.equal(find(plan, 'group:@mantine').members.length, 3)
})

test('a package and its types stub share a family and so share an element', () => {
  const plan = buildPlan({
    updates: [
      npm('lodash', '4.17.20', '4.17.21', { family: 'lodash' }),
      npm('@types/lodash', '4.17.0', '4.17.1', { family: 'lodash' }),
    ],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), ['group:lodash'])
  assert.equal(find(plan, 'group:lodash').members.length, 2)
})

test('updates with no family are never grouped together', () => {
  const plan = buildPlan({
    updates: [
      npm('@types/node', '22.0.0', '22.1.0', { family: null }),
      npm('@types/react', '18.3.1', '18.3.2', { family: null }),
    ],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), ['pkg:@types/node', 'pkg:@types/react'])
})

test('a lone package keeps its full name even if an adapter gave it a family', () => {
  // The family name is only a useful label once it actually groups several
  // packages. Labelling a single package "@playwright" would make it
  // unidentifiable in the PR table and in the apply command.
  const plan = buildPlan({
    updates: [npm('@playwright/test', '1.62.0', '1.62.1', { family: '@playwright' })],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), ['pkg:@playwright/test'])
  assert.equal(plan.tier1[0].label, '@playwright/test')
})

test('a lone survivor of a family keeps its full name after the rest is rejected', () => {
  const plan = buildPlan({
    updates: [
      npm('@mantine/core', '9.4.2', '9.5.1', { family: '@mantine' }),
      npm('@mantine/hooks', '9.4.2', '9.5.1', { family: '@mantine' }),
    ],
    config: config({ reject: ['@mantine/hooks'] }),
  })

  assert.deepEqual(keys(plan.tier1), ['pkg:@mantine/core'])
})

test('a types stub follows its base package into an explicit group', () => {
  const plan = buildPlan({
    updates: [
      npm('react', '18.3.1', '18.3.2', { family: 'react' }),
      npm('@types/react', '18.3.1', '18.3.2', { family: 'react' }),
      npm('@types/node', '22.0.0', '22.1.0', { family: null }),
    ],
    config: config({ groups: { react: ['react', 'react-dom'] } }),
  })

  assert.deepEqual(keys(plan.tier1), ['group:react', 'pkg:@types/node'])
  assert.deepEqual(
    find(plan, 'group:react')
      .members.map((m) => m.name)
      .sort(),
    ['@types/react', 'react'],
  )
})

test('the same family name in two ecosystems does not merge into one element', () => {
  const plan = buildPlan({
    updates: [
      npm('core-a', '1.0.0', '1.0.1', { family: 'core' }),
      npm('core-b', '1.0.0', '1.0.1', { family: 'core' }),
      {
        ecosystem: 'maven',
        name: 'com.example:core-x',
        from: '1.0.0',
        to: '1.0.1',
        bump: 'patch',
        mechanism: 'dependency',
        family: 'core',
      },
      {
        ecosystem: 'maven',
        name: 'com.example:core-y',
        from: '1.0.0',
        to: '1.0.1',
        bump: 'patch',
        mechanism: 'dependency',
        family: 'core',
      },
    ],
    config: config(),
  })

  assert.equal(plan.tier1.length, 2)
  for (const element of plan.tier1) assert.equal(element.members.length, 2)
})

test('explicit config groups still cross ecosystems', () => {
  const plan = buildPlan({
    updates: [
      npm('acme-client', '1.0.0', '1.1.0'),
      {
        ecosystem: 'maven',
        name: 'com.acme:acme-server',
        from: '1.0.0',
        to: '1.1.0',
        bump: 'minor',
        mechanism: 'dependency',
      },
    ],
    config: config({ groups: { acme: ['acme-client', 'com.acme:acme-server'] } }),
  })

  assert.deepEqual(keys(plan.tier1), ['group:acme'])
  assert.equal(find(plan, 'group:acme').members.length, 2)
})

test('a risky member drags its whole group to tier 2', () => {
  const plan = buildPlan({
    updates: [
      npm('vite', '7.1.0', '7.1.1', { family: 'vite' }),
      npm('@vitejs/plugin-react', '5.0.0', '5.0.1', { family: 'vite' }),
    ],
    config: config({ groups: { vite: ['vite', '@vitejs/*'] }, risky: ['vite'] }),
  })

  assert.deepEqual(keys(plan.tier2), ['group:vite'])
  assert.equal(find(plan, 'group:vite').members.length, 2)
})

// ----------------------------------------------------- mechanism opacity

test('core carries an opaque mechanism and element id through untouched', () => {
  const plan = buildPlan({
    updates: [
      {
        ecosystem: 'maven',
        id: 'property:springdoc.version=3.1.0',
        name: 'springdoc.version',
        from: '3.0.3',
        to: '3.1.0',
        bump: 'minor',
        mechanism: 'property',
        artifacts: ['org.springdoc:springdoc-openapi-starter-webmvc-ui'],
      },
    ],
    config: config(),
  })

  const element = find(plan, 'pkg:springdoc.version')
  assert.equal(element.members[0].mechanism, 'property')
  assert.equal(element.members[0].id, 'property:springdoc.version=3.1.0')
  assert.deepEqual(element.members[0].artifacts, [
    'org.springdoc:springdoc-openapi-starter-webmvc-ui',
  ])
})

test('Maven coordinates are not subject to any npm naming rule', () => {
  const plan = buildPlan({
    updates: [
      {
        ecosystem: 'maven',
        name: 'org.postgresql:postgresql',
        from: '42.7.11',
        to: '42.7.13',
        bump: 'patch',
        mechanism: 'dependency',
      },
      {
        ecosystem: 'maven',
        name: 'org.flywaydb:flyway-core',
        from: '12.4.0',
        to: '12.4.1',
        bump: 'patch',
        mechanism: 'dependency',
      },
    ],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), [
    'pkg:org.flywaydb:flyway-core',
    'pkg:org.postgresql:postgresql',
  ])
})

// ------------------------------------------------------------- security

test('security-relevant tier-2 elements are ordered first', () => {
  const plan = buildPlan({
    updates: [
      npm('aaa-alphabetically-first', '1.0.0', '2.0.0'),
      npm('vulnerable-pkg', '1.0.0', '2.0.0'),
    ],
    config: config(),
    alerts: [
      { package: 'vulnerable-pkg', severity: 'high', ghsa: 'GHSA-x', patched_version: '2.0.0' },
    ],
  })

  assert.deepEqual(
    plan.tier2.map((e) => e.label),
    ['vulnerable-pkg', 'aaa-alphabetically-first'],
  )
  assert.equal(plan.tier2[0].security, true)
  assert.equal(plan.tier2[1].security, false)
})

test('an alert on any group member marks the whole group security-relevant', () => {
  const plan = buildPlan({
    updates: [
      npm('@mantine/core', '9.4.2', '9.5.1', { family: '@mantine' }),
      npm('@mantine/hooks', '9.4.2', '9.5.1', { family: '@mantine' }),
    ],
    config: config(),
    alerts: [{ package: '@mantine/hooks', severity: 'moderate', ghsa: 'GHSA-y' }],
  })

  assert.equal(find(plan, 'group:@mantine').security, true)
})

// --------------------------------------------------------------- budget

test('the plan estimates gate runs so the budget can be checked up front', () => {
  const plan = buildPlan({
    updates: [
      npm('zod', '3.22.0', '3.24.0'), // tier 1
      npm('postcss', '8.4.1', '8.4.2'), // tier 1 (same batch)
      npm('eslint', '8.57.0', '9.0.0'), // tier 2
      npm('vitest', '2.0.0', '3.0.0'), // tier 2
    ],
    config: config({ maxGateRuns: 30 }),
    capabilities: ['lockfile', 'audit'],
  })

  // 1 clean gate + 1 tier-1 batch + 2 tier-2 elements + 1 audit pass
  assert.equal(plan.estimatedGateRuns, 5)
  assert.equal(plan.maxGateRuns, 30)
  assert.equal(plan.overBudget, false)
})

test('no audit-capable ecosystem means no audit gate run is budgeted', () => {
  const plan = buildPlan({
    updates: [
      {
        ecosystem: 'maven',
        name: 'org.postgresql:postgresql',
        from: '42.7.11',
        to: '42.7.13',
        bump: 'patch',
        mechanism: 'dependency',
      },
    ],
    config: config(),
    capabilities: [],
  })

  // 1 clean gate + 1 tier-1 batch, and nothing else
  assert.equal(plan.estimatedGateRuns, 2)
})

test('the plan flags when the estimate already exceeds the budget', () => {
  const plan = buildPlan({
    updates: Array.from({ length: 12 }, (_, i) => npm(`major-pkg-${i}`, '1.0.0', '2.0.0')),
    config: config({ maxGateRuns: 6 }),
  })

  assert.equal(plan.overBudget, true)
})

// ------------------------------------------------- reported but not applied

test('a prerelease target is never applied, and is reported not hidden', () => {
  // Version plugins offer RCs freely. A minor-looking prerelease such as
  // 1.3.0-rc1 would otherwise be auto-applied in the tier-1 batch without
  // anyone deciding to adopt an RC.
  const plan = buildPlan({
    updates: [
      npm('safe-pkg', '1.2.3', '1.2.4'),
      npm('rc-pkg', '1.2.3', '1.3.0-rc1'),
      {
        ecosystem: 'maven',
        name: 'jackson-annotations.version',
        from: '2.22',
        to: '3.0-rc5',
        bump: 'major',
        prerelease: true,
        mechanism: 'property',
      },
    ],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), ['pkg:safe-pkg'])
  assert.deepEqual(keys(plan.tier2), [])
  assert.deepEqual(
    plan.prerelease.map((u) => u.name).sort(),
    ['jackson-annotations.version', 'rc-pkg'],
  )
})

test('build metadata after a hyphen is not mistaken for a prerelease', () => {
  const plan = buildPlan({
    updates: [npm('pinned-pkg', '1.2.3-1', '1.2.3-2')],
    config: config(),
  })

  assert.deepEqual(plan.prerelease, [])
  assert.equal(plan.tier1.length + plan.tier2.length, 1)
})

test('updates with no available lever are carried through, not dropped', () => {
  // A dependency pinned by a parent BOM cannot be moved by this run, but hiding
  // it would read as "already up to date" in the PR body.
  const plan = buildPlan({
    updates: [npm('zod', '3.22.0', '3.24.0')],
    unmanageable: [
      {
        ecosystem: 'maven',
        name: 'org.postgresql:postgresql',
        from: '42.7.11',
        to: '42.7.13',
        reason: 'version managed by the parent or an imported BOM',
      },
    ],
    config: config(),
  })

  assert.deepEqual(keys(plan.tier1), ['pkg:zod'])
  assert.deepEqual(
    plan.unmanageable.map((u) => u.name),
    ['org.postgresql:postgresql'],
  )
})
