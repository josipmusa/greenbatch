#!/usr/bin/env node
// Validates a facts JSON document against the adapter contract in
// docs/adapters.md. Used by conformance/run.sh; also useful on its own while
// developing an adapter:
//
//   skills/greenbatch/scripts/adapters/npm/discover . > facts.json
//   node conformance/validate-facts.mjs facts.json
//
// Exit: 0 valid; 1 invalid (every problem is printed, not just the first)

import { readFile } from 'node:fs/promises'

const KNOWN_BUMPS = new Set(['patch', 'minor', 'major', 'unknown'])

const problems = []
const complain = (where, message) => problems.push(`${where}: ${message}`)

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

function validate(facts) {
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) {
    complain('facts', 'must be a JSON object')
    return
  }

  if (!isNonEmptyString(facts.ecosystem)) {
    complain('facts.ecosystem', 'must be a non-empty string')
  }

  if (facts.capabilities !== undefined) {
    if (!Array.isArray(facts.capabilities) || !facts.capabilities.every(isNonEmptyString)) {
      complain('facts.capabilities', 'when present, must be an array of strings')
    }
  }

  // Rule 3: reporting is mandatory. An adapter that cannot pin anything still
  // has to say so with an empty array, because a missing key and "nothing to
  // report" are indistinguishable to a reader of the PR body.
  if (!Array.isArray(facts.unmanageable)) {
    complain('facts.unmanageable', 'must be present as an array, even when empty')
  } else {
    facts.unmanageable.forEach((u, i) => {
      const where = `facts.unmanageable[${i}]`
      for (const field of ['name', 'from', 'to', 'reason']) {
        if (!isNonEmptyString(u?.[field])) complain(where, `${field} must be a non-empty string`)
      }
      if (u?.id !== undefined) {
        complain(where, 'must not carry an id - there is no lever to apply')
      }
    })
  }

  if (!Array.isArray(facts.updates)) {
    complain('facts.updates', 'must be an array')
    return
  }

  const seenIds = new Set()
  facts.updates.forEach((u, i) => {
    const where = `facts.updates[${i}]`

    for (const field of ['id', 'name', 'from', 'to', 'mechanism']) {
      if (!isNonEmptyString(u?.[field])) complain(where, `${field} must be a non-empty string`)
    }

    if (isNonEmptyString(u?.id)) {
      if (seenIds.has(u.id)) complain(where, `duplicate id ${JSON.stringify(u.id)}`)
      seenIds.add(u.id)
    }

    if (u?.bump !== undefined && !KNOWN_BUMPS.has(u.bump)) {
      complain(where, `bump must be one of ${[...KNOWN_BUMPS].join(', ')}, got ${JSON.stringify(u.bump)}`)
    }
    if (u?.prerelease !== undefined && typeof u.prerelease !== 'boolean') {
      complain(where, 'prerelease, when present, must be a boolean')
    }
    if (u?.risky !== undefined && typeof u.risky !== 'boolean') {
      complain(where, 'risky, when present, must be a boolean')
    }
    if (u?.family !== undefined && u.family !== null && !isNonEmptyString(u.family)) {
      complain(where, 'family, when present, must be a non-empty string or null')
    }
  })
}

const path = process.argv[2]
if (!path) {
  process.stderr.write('usage: validate-facts.mjs <facts.json>\n')
  process.exit(1)
}

let facts
try {
  facts = JSON.parse(await readFile(path, 'utf8'))
} catch (err) {
  process.stderr.write(`validate-facts: ${path} is not readable JSON: ${err.message}\n`)
  process.exit(1)
}

validate(facts)

if (problems.length > 0) {
  process.stderr.write('validate-facts: facts JSON violates the adapter contract:\n')
  for (const p of problems) process.stderr.write(`  - ${p}\n`)
  process.exit(1)
}
