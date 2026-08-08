#!/usr/bin/env node
// Reads .claude/greenbatch.yml (or greenbatch.yml) and prints the normalized
// JSON that plan.mjs consumes.
//
// Usage:
//   config.mjs [repo-dir]
//
// Exit: 0 printed the config; 2 the config is invalid; 3 no config file found
//
// Why this exists rather than the agent reading the YAML itself: every other
// mechanical step in a run is a deterministic script, and this one was not. A
// misread config fails silently and in the worst direction - `rejects:` instead
// of `reject:` used to mean the reject list was empty, so a package the user had
// deliberately pinned got updated and nothing in the report said a word about
// it. Unknown keys and wrong types are errors here, never fallbacks.
//
// This parses a deliberately small YAML subset: scalars, inline `[a, b]` lists,
// block `- item` lists, and one level of nested maps. That covers every key the
// config documents. Anything outside it is refused with a line number rather
// than guessed at - a config that silently does not mean what its author wrote
// is worse than one that will not load.
//
// Run the checks with:  node --test tests/

import path from 'node:path'

export class ConfigError extends Error {
  constructor(message, line) {
    super(message)
    this.name = 'ConfigError'
    this.line = line
  }
}

// ------------------------------------------------------------------ parsing

/** Drops a trailing `# comment`, leaving `#` inside quotes alone. */
function stripComment(text) {
  let single = false
  let double = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (c === "'" && !double) single = !single
    else if (c === '"' && !single) double = !double
    else if (c === '#' && !single && !double && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i)
    }
  }
  return text
}

const indentOf = (text) => /^ */.exec(text)[0].length

/** Splits `a, "b, c"` on top-level commas only. */
function splitFlow(body, line) {
  const parts = []
  let current = ''
  let single = false
  let double = false
  for (const c of body) {
    if (c === "'" && !double) single = !single
    else if (c === '"' && !single) double = !double
    if (c === ',' && !single && !double) {
      parts.push(current)
      current = ''
    } else {
      current += c
    }
  }
  parts.push(current)
  if (single || double) throw new ConfigError('unterminated quoted string', line)
  return parts.map((p) => p.trim())
}

function parseScalar(text, line) {
  const s = text.trim()
  if (s === '') return null

  if (s[0] === '"' || s[0] === "'") {
    const quote = s[0]
    if (s.length < 2 || s[s.length - 1] !== quote) {
      throw new ConfigError(`unterminated ${quote} quoted string`, line)
    }
    return s.slice(1, -1)
  }

  // Anchors, aliases, block scalars, and tags: all legal YAML, none supported.
  if ('&*|>!%@`'.includes(s[0])) {
    throw new ConfigError(
      `greenbatch config does not support the YAML construct starting with '${s[0]}'`,
      line,
    )
  }

  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d*\.\d+$/.test(s)) return Number(s)
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  return s
}

function parseFlowList(text, line) {
  const body = text.trim()
  if (body[body.length - 1] !== ']') throw new ConfigError('unterminated [ ... ] list', line)
  const inner = body.slice(1, -1).trim()
  if (inner === '') return []
  return splitFlow(inner, line).map((part) => {
    if (part === '') throw new ConfigError('empty entry in a [ ... ] list', line)
    return parseScalar(part, line)
  })
}

function parseList(lines, start, indent) {
  const out = []
  let i = start
  while (i < lines.length) {
    const { line, text } = lines[i]
    if (text.trim() === '') {
      i += 1
      continue
    }
    const ind = indentOf(text)
    if (ind < indent) break
    if (ind > indent) throw new ConfigError('unexpected indentation inside a list', line)
    const body = text.trim()
    if (body[0] !== '-') break
    const item = body.slice(1).trim()
    if (item === '') throw new ConfigError('a list entry must be on one line', line)
    if (item[0] === '[' || item[0] === '-') {
      throw new ConfigError('nested lists are not supported', line)
    }
    out.push(parseScalar(item, line))
    i += 1
  }
  return [out, i]
}

function parseMap(lines, start, indent, prefix, lineOf) {
  const out = {}
  let i = start
  while (i < lines.length) {
    const { line, text } = lines[i]
    if (text.trim() === '') {
      i += 1
      continue
    }
    const ind = indentOf(text)
    if (ind < indent) break
    if (ind > indent) throw new ConfigError('unexpected indentation', line)

    const match = /^([A-Za-z0-9_.-]+):(.*)$/.exec(text.trim())
    if (!match) {
      throw new ConfigError(
        `expected "key: value", got ${JSON.stringify(text.trim())}`,
        line,
      )
    }
    const [, key, tail] = match
    if (Object.hasOwn(out, key)) throw new ConfigError(`duplicate key '${key}'`, line)
    lineOf.set(prefix + key, line)

    const rest = tail.trim()
    if (rest === '') {
      const [value, next] = parseChild(lines, i + 1, indent, prefix + key + '.', lineOf)
      out[key] = value
      i = next
    } else if (rest[0] === '[') {
      out[key] = parseFlowList(rest, line)
      i += 1
    } else if (rest[0] === '{') {
      throw new ConfigError('inline { ... } maps are not supported; use an indented block', line)
    } else {
      out[key] = parseScalar(rest, line)
      i += 1
    }
  }
  return [out, i]
}

/** The block belonging to a key that had nothing after its colon. */
function parseChild(lines, start, parentIndent, prefix, lineOf) {
  let i = start
  while (i < lines.length && lines[i].text.trim() === '') i += 1
  if (i >= lines.length) return [null, i]

  const ind = indentOf(lines[i].text)
  if (ind <= parentIndent) return [null, i]

  if (lines[i].text.trim()[0] === '-') return parseList(lines, i, ind)
  return parseMap(lines, i, ind, prefix, lineOf)
}

/** The documented YAML subset -> a plain object, plus where each key was written. */
export function parseYaml(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((raw, i) => {
      if (/^\s*\t/.test(raw)) {
        throw new ConfigError('YAML forbids tabs for indentation - use spaces', i + 1)
      }
      return { line: i + 1, text: stripComment(raw).replace(/\s+$/, '') }
    })

  const lineOf = new Map()
  const [value, next] = parseMap(lines, 0, 0, '', lineOf)

  // parseMap stops rather than throwing when it meets something it cannot read
  // at this level; anything left over is a real error, not the end of the file.
  const leftover = lines.slice(next).find((l) => l.text.trim() !== '')
  if (leftover) {
    throw new ConfigError(`expected "key: value", got ${JSON.stringify(leftover.text.trim())}`, leftover.line)
  }

  return { value, lineOf }
}

// --------------------------------------------------------------- validation

const TOP_LEVEL_KEYS = [
  'branches',
  'gate',
  'ecosystems',
  'groups',
  'risky',
  'reject',
  'labels',
  'commit_prefix',
  'max_gate_runs',
]

const BRANCH_KEYS = ['base', 'targets']

/** Edit distance, capped - only used to suggest a key the author probably meant. */
function distance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return rows[a.length][b.length]
}

function suggest(key, candidates) {
  const ranked = candidates
    .map((c) => [c, distance(key, c)])
    .sort((x, y) => x[1] - y[1])
  return ranked.length > 0 && ranked[0][1] <= 3 ? ranked[0][0] : null
}

function rejectUnknown(object, allowed, prefix, lineOf, where) {
  for (const key of Object.keys(object ?? {})) {
    if (allowed.includes(key)) continue
    const hint = suggest(key, allowed)
    throw new ConfigError(
      `unknown ${where} key '${key}'${hint ? ` - did you mean '${hint}'?` : '.'} ` +
        `Known keys: ${allowed.join(', ')}.`,
      lineOf.get(prefix + key),
    )
  }
}

function expectStringList(value, keyPath, lineOf) {
  const line = lineOf.get(keyPath)
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `'${keyPath}' must be a list, for example [a, b] or an indented "- a" block`,
      line,
    )
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError(
        `every entry in '${keyPath}' must be a non-empty string, got ${JSON.stringify(entry)}`,
        line,
      )
    }
  }
  return value
}

function expectString(value, keyPath, lineOf) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`'${keyPath}' must be a non-empty string`, lineOf.get(keyPath))
  }
  return value
}

/** YAML text -> the normalized config, or a ConfigError naming the line. */
export function parseConfig(text) {
  const { value: raw, lineOf } = parseYaml(text)

  rejectUnknown(raw, TOP_LEVEL_KEYS, '', lineOf, 'config')

  const branches = raw.branches ?? {}
  if (typeof branches !== 'object' || Array.isArray(branches)) {
    throw new ConfigError("'branches' must be a block with base and targets", lineOf.get('branches'))
  }
  rejectUnknown(branches, BRANCH_KEYS, 'branches.', lineOf, 'branches')

  const base = branches.base === undefined ? 'main' : expectString(branches.base, 'branches.base', lineOf)
  const targets =
    branches.targets === undefined
      ? [base]
      : expectStringList(branches.targets, 'branches.targets', lineOf)
  if (targets.length === 0) {
    throw new ConfigError("'branches.targets' must name at least one branch", lineOf.get('branches.targets'))
  }

  // There is no default gate and there never will be: a gate the user has not
  // approved makes every "verified" claim in every future run untrue.
  if (raw.gate === undefined) {
    throw new ConfigError(
      "'gate' is required - greenbatch never invents one, because a gate nobody " +
        'approved would make every claim in the report untrue. Run greenbatch ' +
        'interactively once to produce a config.',
      undefined,
    )
  }
  const gate = expectString(raw.gate, 'gate', lineOf)

  let ecosystems = 'auto'
  if (raw.ecosystems !== undefined && raw.ecosystems !== 'auto') {
    ecosystems = expectStringList(raw.ecosystems, 'ecosystems', lineOf)
  }

  const groups = {}
  if (raw.groups !== undefined) {
    if (typeof raw.groups !== 'object' || raw.groups === null || Array.isArray(raw.groups)) {
      throw new ConfigError("'groups' must be a block of name: [patterns]", lineOf.get('groups'))
    }
    for (const [name, patterns] of Object.entries(raw.groups)) {
      groups[name] = expectStringList(patterns, `groups.${name}`, lineOf)
    }
  }

  const listOrEmpty = (key) =>
    raw[key] === undefined ? [] : expectStringList(raw[key], key, lineOf)

  let maxGateRuns = 30
  if (raw.max_gate_runs !== undefined) {
    if (typeof raw.max_gate_runs !== 'number' || !Number.isInteger(raw.max_gate_runs) || raw.max_gate_runs < 1) {
      throw new ConfigError(
        "'max_gate_runs' must be a whole number of gate runs, at least 1",
        lineOf.get('max_gate_runs'),
      )
    }
    maxGateRuns = raw.max_gate_runs
  }

  return {
    base,
    targets,
    // Every target other than the base gets a derived branch that is re-gated
    // after the merge, and the budget estimate has to account for those.
    derivedTargets: targets.filter((t) => t !== base).length,
    gate,
    ecosystems,
    groups,
    risky: listOrEmpty('risky'),
    reject: listOrEmpty('reject'),
    labels: listOrEmpty('labels'),
    commitPrefix:
      raw.commit_prefix === undefined ? 'build' : expectString(raw.commit_prefix, 'commit_prefix', lineOf),
    maxGateRuns,
  }
}

// ---------------------------------------------------------------------- CLI

/**
 * Where the config lives. `.claude/greenbatch.yml` is canonical; the root file
 * is the fallback so an agent other than Claude Code can drive a run without the
 * repo needing a `.claude/` directory. When both exist the canonical one wins
 * and the run says so, rather than silently reading one of two plausible files.
 */
export async function findConfig(repoDir, { access } = {}) {
  const exists = async (p) => {
    try {
      await access(p)
      return true
    } catch {
      return false
    }
  }

  const canonical = path.join(repoDir, '.claude', 'greenbatch.yml')
  const fallback = path.join(repoDir, 'greenbatch.yml')

  const hasCanonical = await exists(canonical)
  const hasFallback = await exists(fallback)

  if (hasCanonical) return { path: canonical, shadowed: hasFallback ? fallback : null }
  if (hasFallback) return { path: fallback, shadowed: null }
  return null
}

async function main(argv) {
  const { readFile, access } = await import('node:fs/promises')
  const repoDir = argv[0] ?? '.'

  const found = await findConfig(repoDir, { access })
  if (!found) {
    process.stderr.write(
      `config: no greenbatch config found. Looked for:\n` +
        `  ${path.join(repoDir, '.claude', 'greenbatch.yml')}\n` +
        `  ${path.join(repoDir, 'greenbatch.yml')}\n` +
        `Run greenbatch interactively once to produce one.\n`,
    )
    process.exit(3)
  }

  if (found.shadowed) {
    process.stderr.write(
      `config: using ${found.path}; ${found.shadowed} exists but is shadowed by it.\n`,
    )
  }

  let config
  try {
    config = parseConfig(await readFile(found.path, 'utf8'))
  } catch (err) {
    if (err instanceof ConfigError) {
      const at = err.line === undefined ? found.path : `${found.path}:${err.line}`
      process.stderr.write(`config: ${at}\n  ${err.message}\n`)
      process.exit(2)
    }
    process.stderr.write(`config: could not read ${found.path}: ${err.message}\n`)
    process.exit(2)
  }

  process.stdout.write(`${JSON.stringify({ ...config, path: found.path }, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`config: ${err.message}\n`)
    process.exit(2)
  })
}
