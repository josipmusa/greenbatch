import { test } from 'node:test'
import assert from 'node:assert/strict'

import rules from '../scripts/adapters/npm/rules.cjs'

const { assignFamilies, buildUpdates, isPrerelease, npmScope, semverBump, typesBaseOf } = rules

const update = (name) => ({ name })
const familiesOf = (names) => {
  const out = assignFamilies(names.map(update))
  return Object.fromEntries(out.map((u) => [u.name, u.family]))
}

// ------------------------------------------------------------ bump

test('semverBump classifies the three ordinary cases', () => {
  assert.equal(semverBump('1.2.3', '1.2.4'), 'patch')
  assert.equal(semverBump('1.2.3', '1.3.0'), 'minor')
  assert.equal(semverBump('1.2.3', '2.0.0'), 'major')
})

test('semverBump tolerates a leading v', () => {
  assert.equal(semverBump('v1.2.3', 'v1.2.4'), 'patch')
})

test('semverBump reports unknown rather than guessing at an odd range', () => {
  // Core keeps unknown bumps out of tier 1, so this is the safe answer.
  assert.equal(semverBump('1.x', '2.x'), 'unknown')
  assert.equal(semverBump('nightly', 'latest'), 'unknown')
})

// ------------------------------------------------------ prerelease

test('isPrerelease catches the tags a run must not adopt on its own', () => {
  for (const v of ['1.3.0-rc1', '2.0.0-alpha.1', '3.0.0-beta', '1.0.0-next.4', '5.0.0-canary']) {
    assert.equal(isPrerelease(v), true, `${v} should be a prerelease`)
  }
})

test('isPrerelease leaves stable versions alone', () => {
  for (const v of ['1.2.3', '10.0.0', '2.1.3']) {
    assert.equal(isPrerelease(v), false, `${v} should not be a prerelease`)
  }
})

test('build metadata after a hyphen is not a prerelease', () => {
  assert.equal(isPrerelease('1.2.3-1'), false)
})

// ----------------------------------------------------------- scopes

test('npmScope returns the scope of a scoped package', () => {
  assert.equal(npmScope('@mantine/core'), '@mantine')
  assert.equal(npmScope('lodash'), null)
})

test('npmScope excludes @types, which is a namespace and not a family', () => {
  assert.equal(npmScope('@types/node'), null)
})

test('typesBaseOf resolves the package a stub describes', () => {
  assert.equal(typesBaseOf('@types/lodash'), 'lodash')
  assert.equal(typesBaseOf('@types/mantine__core'), '@mantine/core')
  assert.equal(typesBaseOf('lodash'), null)
})

// --------------------------------------------------------- families

test('packages sharing a scope get one family, named for the scope', () => {
  assert.deepEqual(familiesOf(['@mantine/core', '@mantine/hooks', '@mantine/form']), {
    '@mantine/core': '@mantine',
    '@mantine/hooks': '@mantine',
    '@mantine/form': '@mantine',
  })
})

test('a package and its types stub share a family named for the package', () => {
  assert.deepEqual(familiesOf(['lodash', '@types/lodash']), {
    lodash: 'lodash',
    '@types/lodash': 'lodash',
  })
})

test('unrelated @types stubs are never grouped with each other', () => {
  // @types is a namespace of unrelated stubs. Grouping @types/node with
  // @types/react would make one failure revert both.
  assert.deepEqual(familiesOf(['@types/node', '@types/react']), {
    '@types/node': null,
    '@types/react': null,
  })
})

test('a lone scoped package gets no family', () => {
  assert.deepEqual(familiesOf(['@playwright/test']), { '@playwright/test': null })
})

test('a scoped stub joins the scope family of the package it describes', () => {
  const families = familiesOf(['@mantine/core', '@mantine/hooks', '@types/mantine__core'])

  const distinct = new Set(Object.values(families))
  assert.equal(distinct.size, 1, 'all three belong to one family')
  // The set mixes a scoped package with an unscoped stub, so the shortest
  // member name is the readable label rather than the bare scope.
  assert.equal(families['@types/mantine__core'], '@mantine/core')
})

test('a types stub whose base package has no update stays on its own', () => {
  assert.deepEqual(familiesOf(['@types/lodash', 'zod']), {
    '@types/lodash': null,
    zod: null,
  })
})

test('two separate families do not bleed into each other', () => {
  const families = familiesOf(['@mantine/core', '@mantine/hooks', 'lodash', '@types/lodash'])

  assert.equal(families['@mantine/core'], '@mantine')
  assert.equal(families['@mantine/hooks'], '@mantine')
  assert.equal(families.lodash, 'lodash')
  assert.equal(families['@types/lodash'], 'lodash')
})

// ------------------------------------------------------ buildUpdates

test('buildUpdates pairs the declared range with the offered one', () => {
  const pkg = { dependencies: { zod: '^3.22.0' }, devDependencies: { vitest: '~2.0.0' } }
  const updates = buildUpdates(pkg, { zod: '^3.24.0', vitest: '~3.0.0' })

  assert.deepEqual(
    updates.map((u) => [u.name, u.from, u.to, u.bump]),
    [
      ['vitest', '2.0.0', '3.0.0', 'major'],
      ['zod', '3.22.0', '3.24.0', 'minor'],
    ],
  )
})

test('buildUpdates makes the element id the package name', () => {
  const updates = buildUpdates({ dependencies: { zod: '3.22.0' } }, { zod: '3.24.0' })

  assert.equal(updates[0].id, 'zod')
  assert.equal(updates[0].mechanism, 'npm')
})

test('buildUpdates skips a package the manifest does not declare', () => {
  // ncu occasionally reports something we cannot locate a `from` for; guessing
  // would put a fabricated version in the PR body.
  const updates = buildUpdates({ dependencies: { zod: '3.22.0' } }, { zod: '3.24.0', ghost: '9.9.9' })

  assert.deepEqual(
    updates.map((u) => u.name),
    ['zod'],
  )
})

test('buildUpdates reads every dependency section', () => {
  const pkg = {
    dependencies: { a: '1.0.0' },
    devDependencies: { b: '1.0.0' },
    optionalDependencies: { c: '1.0.0' },
    peerDependencies: { d: '1.0.0' },
  }
  const updates = buildUpdates(pkg, { a: '1.0.1', b: '1.0.1', c: '1.0.1', d: '1.0.1' })

  assert.deepEqual(
    updates.map((u) => u.name),
    ['a', 'b', 'c', 'd'],
  )
})

test('buildUpdates assigns families as part of discovery', () => {
  const pkg = { dependencies: { '@mantine/core': '9.4.2', '@mantine/hooks': '9.4.2' } }
  const updates = buildUpdates(pkg, { '@mantine/core': '9.5.1', '@mantine/hooks': '9.5.1' })

  assert.deepEqual(
    updates.map((u) => u.family),
    ['@mantine', '@mantine'],
  )
})

test('buildUpdates flags a prerelease target', () => {
  const updates = buildUpdates({ dependencies: { pkg: '1.2.3' } }, { pkg: '1.3.0-rc1' })

  assert.equal(updates[0].prerelease, true)
})
