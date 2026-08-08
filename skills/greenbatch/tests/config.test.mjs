import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ConfigError, parseConfig } from '../scripts/core/config.mjs'

/** The error a bad config produces, so tests can assert on line and message. */
const failure = (text) => {
  try {
    parseConfig(text)
    assert.fail('expected parseConfig to reject this config')
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    return err
  }
}

const minimal = 'gate: "npm test"\n'

// ------------------------------------------------------------- the happy path

test('parses the documented example into the shape plan.mjs consumes', () => {
  const config = parseConfig(`
branches:
  base: main
  targets: [dev, main]
gate: "npm ci && npm run verify"
ecosystems: auto
groups:
  react: ["react", "react-dom", "@types/react"]
  vite: ["vite", "@vitejs/*"]
risky: ["react", "vite"]
reject: []
labels: ["dependencies"]
commit_prefix: "build"
max_gate_runs: 30
`)

  assert.equal(config.base, 'main')
  assert.deepEqual(config.targets, ['dev', 'main'])
  assert.equal(config.gate, 'npm ci && npm run verify')
  assert.equal(config.ecosystems, 'auto')
  assert.deepEqual(config.groups, {
    react: ['react', 'react-dom', '@types/react'],
    vite: ['vite', '@vitejs/*'],
  })
  assert.deepEqual(config.risky, ['react', 'vite'])
  assert.deepEqual(config.reject, [])
  assert.deepEqual(config.labels, ['dependencies'])
  assert.equal(config.commitPrefix, 'build')
  assert.equal(config.maxGateRuns, 30)
})

test('block sequences are accepted alongside inline lists', () => {
  const config = parseConfig(`
gate: npm test
risky:
  - react
  - vite
branches:
  base: trunk
  targets:
    - trunk
    - release
`)

  assert.deepEqual(config.risky, ['react', 'vite'])
  assert.deepEqual(config.targets, ['trunk', 'release'])
  assert.equal(config.base, 'trunk')
})

test('comments and blank lines are ignored', () => {
  const config = parseConfig(`
# the gate is the whole basis for calling these updates verified
gate: npm test   # inline comments too

risky: []
`)

  assert.equal(config.gate, 'npm test')
})

test('a # inside a quoted string is not a comment', () => {
  const config = parseConfig('gate: "npm run build -- --tag=#1"\n')

  assert.equal(config.gate, 'npm run build -- --tag=#1')
})

// ------------------------------------------------------------------ defaults

test('an absent optional key takes its documented default', () => {
  const config = parseConfig(minimal)

  assert.equal(config.base, 'main')
  assert.deepEqual(config.targets, ['main'])
  assert.equal(config.ecosystems, 'auto')
  assert.deepEqual(config.groups, {})
  assert.deepEqual(config.risky, [])
  assert.deepEqual(config.reject, [])
  assert.equal(config.maxGateRuns, 30)
})

test('targets defaults to the base branch alone', () => {
  const config = parseConfig('gate: npm test\nbranches:\n  base: trunk\n')

  assert.deepEqual(config.targets, ['trunk'])
  assert.equal(config.derivedTargets, 0)
})

test('derivedTargets counts the targets that need their own branch', () => {
  // The base-bound branch is cut directly; every other target gets a derived
  // branch that is re-gated, and the gate estimate has to include those.
  const config = parseConfig('gate: npm test\nbranches:\n  base: main\n  targets: [dev, main, release]\n')

  assert.equal(config.derivedTargets, 2)
})

// --------------------------------------------------------------- the point

test('an unknown top-level key is an error, not a silent fallback', () => {
  // This is the whole reason this file exists. `rejects` instead of `reject`
  // used to mean the reject list was empty, so a package the user had
  // deliberately pinned got updated and nothing said a word.
  const err = failure('gate: npm test\nrejects: ["left-pad"]\n')

  assert.equal(err.line, 2)
  assert.match(err.message, /rejects/)
  assert.match(err.message, /reject/)
})

test('a near-miss key suggests the real one', () => {
  assert.match(failure('gate: npm test\nmax_gate_run: 5\n').message, /max_gate_runs/)
  assert.match(failure('gate: npm test\nlabel: ["deps"]\n').message, /labels/)
})

test('an unknown key inside branches is an error too', () => {
  const err = failure('gate: npm test\nbranches:\n  base: main\n  target: [dev]\n')

  assert.equal(err.line, 4)
  assert.match(err.message, /targets/)
})

// -------------------------------------------------------------- type errors

test('a scalar where a list belongs is rejected at its line', () => {
  const err = failure('gate: npm test\nrisky: react\n')

  assert.equal(err.line, 2)
  assert.match(err.message, /list/)
})

test('a list where a string belongs is rejected', () => {
  assert.match(failure('gate: ["npm", "test"]\n').message, /string/)
})

test('max_gate_runs must be a number', () => {
  const err = failure('gate: npm test\nmax_gate_runs: "thirty"\n')

  assert.equal(err.line, 2)
  assert.match(err.message, /number/)
})

test('a group must map to a list of patterns', () => {
  const err = failure('gate: npm test\ngroups:\n  react: react-dom\n')

  assert.equal(err.line, 3)
  assert.match(err.message, /list/)
})

test('every list entry must be a string', () => {
  assert.match(failure('gate: npm test\nrisky: [react, 42]\n').message, /string/)
})

// ------------------------------------------------------------ the gate rule

test('a config with no gate is rejected rather than defaulted', () => {
  // A gate nobody approved would make every "verified" claim in every future
  // run untrue, so there is no default and never will be.
  assert.match(failure('branches:\n  base: main\n').message, /gate/)
})

test('an empty gate is rejected too', () => {
  assert.match(failure('gate: ""\n').message, /gate/)
})

// ----------------------------------------------------- unsupported YAML

test('tabs are rejected with an explanation', () => {
  const err = failure('gate: npm test\nrisky:\n\t- react\n')

  assert.equal(err.line, 3)
  assert.match(err.message, /tab/i)
})

test('a duplicate key is an error rather than last-one-wins', () => {
  const err = failure('gate: npm test\nrisky: [a]\nrisky: [b]\n')

  assert.equal(err.line, 3)
  assert.match(err.message, /duplicate/)
})

test('YAML features outside the documented subset are refused, not guessed at', () => {
  // Silently mis-parsing an anchor would be worse than refusing it: the run
  // would proceed with a config that does not say what the author wrote.
  assert.match(failure('gate: npm test\nrisky: &anchor [a]\n').message, /support/)
})

test('an unparseable line names itself', () => {
  const err = failure('gate: npm test\nthis is not yaml\n')

  assert.equal(err.line, 2)
})
