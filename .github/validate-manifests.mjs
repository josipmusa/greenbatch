#!/usr/bin/env node
// Validates the plugin manifests and every SKILL.md frontmatter block.
//
// These files are only read by tooling, so a typo in one is invisible until an
// install fails for someone else. Run: node .github/validate-manifests.mjs
//
// Exit: 0 valid; 1 invalid (every problem is printed, not just the first)

import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const problems = []
const complain = (where, message) => problems.push(`${where}: ${message}`)

const readJson = async (rel) => {
  try {
    return JSON.parse(await readFile(path.join(root, rel), 'utf8'))
  } catch (err) {
    complain(rel, `unreadable or invalid JSON: ${err.message}`)
    return null
  }
}

// ------------------------------------------------------------ plugin.json

const plugin = await readJson('.claude-plugin/plugin.json')
if (plugin) {
  if (typeof plugin.name !== 'string' || !/^[a-z0-9-]+$/.test(plugin.name)) {
    complain('plugin.json', 'name must be lowercase letters, digits, and hyphens')
  }
  if (typeof plugin.version !== 'string' || !/^\d+\.\d+\.\d+/.test(plugin.version)) {
    complain('plugin.json', 'version must be semver')
  }
  if (typeof plugin.description !== 'string' || plugin.description.trim() === '') {
    complain('plugin.json', 'description is required')
  }
}

// ------------------------------------------------------- marketplace.json

const marketplace = await readJson('.claude-plugin/marketplace.json')
if (marketplace) {
  if (typeof marketplace.name !== 'string' || !/^[a-z0-9-]+$/.test(marketplace.name)) {
    complain('marketplace.json', 'name must be lowercase letters, digits, and hyphens')
  }
  if (!marketplace.owner || typeof marketplace.owner.name !== 'string') {
    complain('marketplace.json', 'owner.name is required')
  }
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    complain('marketplace.json', 'plugins must be a non-empty array')
  } else {
    marketplace.plugins.forEach((entry, i) => {
      const where = `marketplace.json plugins[${i}]`
      if (typeof entry.name !== 'string') complain(where, 'name is required')
      if (typeof entry.source !== 'string') complain(where, 'source is required')
      // A source pointing at a directory has to actually contain a plugin.
      if (typeof entry.source === 'string' && entry.source.startsWith('.')) {
        const target = path.join(root, entry.source, '.claude-plugin/plugin.json')
        if (!existsSync(target)) complain(where, `source ${entry.source} has no .claude-plugin/plugin.json`)
      }
      if (plugin && entry.name === plugin.name && entry.version !== plugin.version) {
        complain(where, `version ${entry.version} disagrees with plugin.json ${plugin.version}`)
      }
    })
  }
}

// ----------------------------------------------------------- SKILL.md

// The Agent Skills open standard: YAML frontmatter carrying name and
// description, and nothing else.
const ALLOWED_FRONTMATTER_KEYS = new Set(['name', 'description'])

const skillsDir = path.join(root, 'skills')
let skillNames = []
try {
  skillNames = (await readdir(skillsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
} catch {
  complain('skills/', 'directory is missing')
}

if (skillNames.length === 0) complain('skills/', 'contains no skills')

for (const name of skillNames) {
  const rel = `skills/${name}/SKILL.md`
  let raw
  try {
    raw = await readFile(path.join(root, rel), 'utf8')
  } catch {
    complain(rel, 'is missing')
    continue
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw)
  if (!match) {
    complain(rel, 'has no YAML frontmatter block')
    continue
  }

  // Deliberately not a YAML parser: the standard allows only two scalar keys, so
  // anything a line-based read cannot handle is itself the problem.
  const fields = new Map()
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '') continue
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) {
      complain(rel, `frontmatter line is not a simple key: value pair: ${JSON.stringify(line)}`)
      continue
    }
    if (fields.has(kv[1])) complain(rel, `duplicate frontmatter key ${kv[1]}`)
    fields.set(kv[1], kv[2].trim())
  }

  for (const key of fields.keys()) {
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
      complain(rel, `frontmatter key ${JSON.stringify(key)} is not part of the Agent Skills standard`)
    }
  }

  const skillName = fields.get('name')
  if (!skillName) {
    complain(rel, 'frontmatter is missing name')
  } else {
    if (!/^[a-z0-9-]{1,64}$/.test(skillName)) {
      complain(rel, 'name must be 1-64 chars of lowercase letters, digits, and hyphens')
    }
    if (skillName !== name) {
      complain(rel, `name ${JSON.stringify(skillName)} does not match its directory ${JSON.stringify(name)}`)
    }
  }

  const description = fields.get('description')
  if (!description) {
    complain(rel, 'frontmatter is missing description')
  } else if (description.length > 1024) {
    complain(rel, `description is ${description.length} chars, over the 1024 limit`)
  } else if (!/\bNOT\b/.test(description)) {
    // The description is the only thing a model sees when deciding whether to
    // trigger, so the cases this skill is not for have to be in it.
    complain(rel, 'description should state what the skill is NOT for')
  }
}

// ------------------------------------------------------------- commands/

// A slash command is the first thing anyone types, so a broken one is the most
// visible possible defect. This exists because the README documented
// `/greenbatch run` for a command that had no file at all.
const commandsDir = path.join(root, 'commands')
let commandFiles = []
try {
  commandFiles = (await readdir(commandsDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
} catch {
  complain('commands/', 'directory is missing')
}

if (commandFiles.length === 0) complain('commands/', 'contains no commands')

for (const file of commandFiles) {
  const rel = `commands/${file}`
  const raw = await readFile(path.join(commandsDir, file), 'utf8')

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw)
  if (!match) {
    complain(rel, 'has no YAML frontmatter block')
    continue
  }
  if (!/^description:\s*\S/m.test(match[1])) {
    complain(rel, 'frontmatter is missing a description')
  }
}

// --------------------------------------------------------- adapter.json

const adaptersDir = path.join(root, 'skills/greenbatch/scripts/adapters')
let adapters = []
try {
  adapters = (await readdir(adaptersDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
} catch {
  complain('scripts/adapters/', 'directory is missing')
}

for (const adapter of adapters) {
  const rel = `skills/greenbatch/scripts/adapters/${adapter}/adapter.json`
  const manifest = await readJson(rel)
  if (!manifest) continue

  if (manifest.name !== adapter) {
    complain(rel, `name ${JSON.stringify(manifest.name)} does not match its directory`)
  }
  if (!['core', 'community'].includes(manifest.status)) {
    complain(rel, 'status must be "core" or "community"')
  }
  if (!Array.isArray(manifest.requires) || manifest.requires.length === 0) {
    complain(rel, 'requires must list the executables this adapter needs')
  }
  if (!manifest.conformance || typeof manifest.conformance.unmatchedId !== 'string') {
    complain(rel, 'conformance.unmatchedId is required so the exit-4 check can run')
  }
  const rejectFixtures = manifest.conformance?.rejectFixtures
  if (rejectFixtures !== undefined) {
    if (!Array.isArray(rejectFixtures)) {
      complain(rel, 'conformance.rejectFixtures, when present, must be an array of paths')
    } else {
      // A decoy that has been renamed or deleted turns a real assertion into a
      // conformance error nobody sees until CI runs.
      for (const dir of rejectFixtures) {
        if (!existsSync(path.join(root, dir))) {
          complain(rel, `conformance.rejectFixtures names a missing directory: ${dir}`)
        }
      }
    }
  }
  if (
    manifest.conformance?.gate !== undefined &&
    typeof manifest.conformance.gate !== 'string'
  ) {
    complain(rel, 'conformance.gate, when present, must be a command string')
  }
  if (!Array.isArray(manifest.manifests) || manifest.manifests.length === 0) {
    complain(rel, 'manifests must list the files this adapter edits')
  }

  for (const script of ['detect', 'discover', 'apply', 'revert']) {
    if (!existsSync(path.join(adaptersDir, adapter, script))) {
      complain(rel, `adapter is missing its ${script} script`)
    }
  }
}

if (problems.length > 0) {
  process.stderr.write('validate-manifests: found problems:\n')
  for (const p of problems) process.stderr.write(`  - ${p}\n`)
  process.exit(1)
}

process.stdout.write(
  `validate-manifests: ok (${skillNames.length} skill(s), ${commandFiles.length} command(s), ` +
    `${adapters.length} adapter(s))\n`,
)
