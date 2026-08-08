#!/usr/bin/env node
// Turns adapter facts + normalized config into a tiered, grouped plan.
//
// Usage:
//   plan.mjs --config <normalized.json> --discover <facts.json> [--discover <facts.json>...]
//            [--alerts <alerts.json>]
//
// Prints the plan as JSON on stdout. Deterministic: same inputs -> same output.
//
// This file knows nothing about any ecosystem. Everything ecosystem-specific -
// how a version bump is classified, whether a version is a prerelease, which
// packages belong together, which updates have no lever - arrives in the facts
// JSON from an adapter. See docs/adapters.md for the contract.
//
// Run the checks with:  node --test tests/

/** Does `name` match a pattern that may end in `*`? */
function matches(name, pattern) {
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1))
  return name === pattern
}

const matchesAny = (name, patterns) => patterns.some((p) => matches(name, p))

/**
 * patch | minor | major, or 'major' when either version is not plain semver.
 *
 * FALLBACK ONLY: used when an adapter omits `bump`. An adapter that knows its
 * ecosystem's versioning scheme (PEP 440, Maven qualifiers, Go pseudo-versions)
 * should classify the bump itself and report it. Unparseable bumps are
 * deliberately conservative: an unknown shape is never allowed into tier 1.
 */
export function semverBump(from, to) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const a = parse(from)
  const b = parse(to)
  if (!a || !b) return 'major'
  if (a[0] !== b[0]) return 'major'
  if (a[1] !== b[1]) return 'minor'
  return 'patch'
}

/**
 * Is this version a prerelease (RC, alpha, beta, snapshot, Spring-style .RC1)?
 *
 * FALLBACK ONLY, same as `semverBump`: an adapter that reports `prerelease`
 * overrides this. Version plugins happily offer release candidates, and a
 * minor-looking one such as 1.3.0-rc1 would otherwise be applied in the tier-1
 * batch - adopting an RC that nobody chose. A hyphen followed only by digits is
 * build metadata (1.2.3-1), not a prerelease.
 */
export function isPrerelease(version) {
  const v = String(version ?? '').trim()
  return /-[^-]*[a-z]/i.test(v) || /\.(?:rc|m|cr)\d+$/i.test(v) || /snapshot/i.test(v)
}

const KNOWN_BUMPS = new Set(['patch', 'minor', 'major', 'unknown'])

/** The adapter's bump if it reported one, else the semver fallback. */
function resolveBump(update) {
  if (typeof update.bump === 'string') {
    // A value this core does not recognise is treated as unknown, never as a
    // small bump: a typo in an adapter must not open the tier-1 batch.
    return KNOWN_BUMPS.has(update.bump) ? update.bump : 'unknown'
  }
  return semverBump(update.from, update.to)
}

/** The adapter's prerelease verdict if it reported one, else the fallback. */
function resolvePrerelease(update) {
  if (typeof update.prerelease === 'boolean') return update.prerelease
  return isPrerelease(update.to)
}

/** Union-find over update indices. */
function unionFind(size) {
  const parent = Array.from({ length: size }, (_, i) => i)
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (a, b) => {
    const [ra, rb] = [find(a), find(b)]
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  return { find, union }
}

/** The one family shared by every member, or null if they do not share one. */
function sharedFamily(members) {
  const families = new Set(members.map((m) => m.family ?? null))
  if (families.size !== 1) return null
  const [only] = [...families]
  return only || null
}

export function buildPlan({
  updates,
  config,
  alerts = [],
  unmanageable = [],
  capabilities = [],
  notes = [],
}) {
  const reject = config.reject ?? []
  const risky = config.risky ?? []
  const groups = config.groups ?? {}

  const rejected = []
  const prerelease = []
  const kept = []
  for (const u of updates) {
    if (matchesAny(u.name, reject)) {
      rejected.push({ ...u, reason: 'reject list' })
    } else if (resolvePrerelease(u)) {
      prerelease.push({ ...u, reason: 'target version is a prerelease' })
    } else {
      kept.push({ ...u, bump: resolveBump(u) })
    }
  }

  const { find, union } = unionFind(kept.length)
  const explicitName = new Map() // root index -> config group name

  // 1. Explicit config groups - the only rule that crosses ecosystems, and the
  //    only one core owns.
  for (const [name, patterns] of Object.entries(groups)) {
    const members = kept
      .map((u, i) => (matchesAny(u.name, patterns) ? i : -1))
      .filter((i) => i >= 0)
    if (members.length === 0) continue
    for (const i of members.slice(1)) union(members[0], i)
    explicitName.set(find(members[0]), name)
  }

  // 2. Adapter-supplied families. Whichever relationships an ecosystem considers
  //    inseparable - a shared npm scope, a package and its types stub, a set of
  //    coordinates released in lockstep - the adapter expresses by giving those
  //    updates the same `family` string. Core just unions them. Families are
  //    scoped to their ecosystem, so two adapters that happen to pick the same
  //    family name never merge into one element.
  const byFamily = new Map()
  kept.forEach((u, i) => {
    if (!u.family) return
    const key = `${u.ecosystem ?? ''}\u0000${u.family}`
    if (byFamily.has(key)) union(byFamily.get(key), i)
    else byFamily.set(key, i)
  })

  // Explicit names must survive any merge that happened after step 1.
  const namesByRoot = new Map()
  for (const [root, name] of explicitName) {
    const current = find(root)
    if (!namesByRoot.has(current)) namesByRoot.set(current, name)
  }

  const alertedPackages = new Set(alerts.map((a) => a.package))

  const sets = new Map()
  kept.forEach((u, i) => {
    const root = find(i)
    if (!sets.has(root)) sets.set(root, [])
    sets.get(root).push(u)
  })

  const elements = [...sets.entries()].map(([root, members]) => {
    const explicit = namesByRoot.get(root)
    const grouped = explicit !== undefined || members.length > 1

    // A family only earns the label once it actually groups several packages;
    // for a lone package the family name ("@playwright") would be
    // unidentifiable in both the PR table and the apply command.
    const family = members.length > 1 ? sharedFamily(members) : null
    const shortestName = members
      .map((m) => m.name)
      .sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
    const label = explicit ?? family ?? shortestName

    return {
      key: grouped ? `group:${label}` : `pkg:${label}`,
      label,
      grouped,
      members: members.slice().sort((a, b) => a.name.localeCompare(b.name)),
      // Tier 2 is majors, anything the adapter flagged risky (a parent POM bump
      // moves a whole managed version set however small the step looks), and
      // anything the config named risky. `unknown` is conservative, not small.
      tier: members.some(
        (m) =>
          m.bump === 'major' ||
          m.bump === 'unknown' ||
          m.risky === true ||
          matchesAny(m.name, risky),
      )
        ? 2
        : 1,
      security: members.some((m) => alertedPackages.has(m.name)),
    }
  })

  const byName = (a, b) => a.label.localeCompare(b.label)
  const tier1 = elements.filter((e) => e.tier === 1).sort(byName)
  // Security-relevant first, then the widest elements, then alphabetical - the
  // budget may run out partway through tier 2, so the order is the priority.
  const tier2 = elements
    .filter((e) => e.tier === 2)
    .sort(
      (a, b) =>
        Number(b.security) - Number(a.security) ||
        b.members.length - a.members.length ||
        byName(a, b),
    )

  // One clean-branch gate, one tier-1 batch gate (if there is a batch), one per
  // tier-2 element, and one pass per audit-capable ecosystem. A tier-1 bisect
  // adds runs beyond this, which is why the estimate is a floor and tier 1 is
  // never budget-capped.
  const maxGateRuns = config.maxGateRuns ?? 30
  const estimatedGateRuns =
    1 +
    (tier1.length > 0 ? 1 : 0) +
    tier2.length +
    (capabilities.includes('audit') ? 1 : 0)

  return {
    tier1,
    tier2,
    rejected,
    // Deliberately not applied, but reported rather than hidden: adopting an RC
    // is a human decision, and silence would read as "already up to date".
    prerelease,
    // Available updates with no lever this run can pull (a version pinned by a
    // parent or an imported BOM). Reported so the PR body can say so out loud.
    unmanageable,
    // Caveats about what discovery did not look at, as opposed to what it could
    // not move. A run that scanned only a Maven reactor's root pom has to say
    // so, or the report claims a coverage it never had.
    notes,
    maxGateRuns,
    estimatedGateRuns,
    overBudget: estimatedGateRuns > maxGateRuns,
  }
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { discover: [], config: null, alerts: null }
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]]
    if (flag === '--discover') out.discover.push(value)
    else if (flag === '--config') out.config = value
    else if (flag === '--alerts') out.alerts = value
    else {
      process.stderr.write(`plan.mjs: unknown argument ${flag}\n`)
      process.exit(2)
    }
  }
  return out
}

async function main(argv) {
  const { readFile } = await import('node:fs/promises')
  const args = parseArgs(argv)

  if (!args.config || args.discover.length === 0) {
    process.stderr.write(
      'usage: plan.mjs --config <normalized.json> --discover <facts.json> [--discover ...] [--alerts <alerts.json>]\n',
    )
    process.exit(2)
  }

  const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
  const config = await readJson(args.config)
  const facts = await Promise.all(args.discover.map(readJson))
  const alerts = args.alerts ? await readJson(args.alerts) : []

  // Stamp each fact with the ecosystem it came from: the reports name it, and
  // family grouping is scoped by it.
  const stamp = (f, key) =>
    (f[key] ?? []).map((entry) => ({ ecosystem: f.ecosystem, ...entry }))

  const updates = facts.flatMap((f) => stamp(f, 'updates'))
  const unmanageable = facts.flatMap((f) => stamp(f, 'unmanageable'))
  const capabilities = [...new Set(facts.flatMap((f) => f.capabilities ?? []))]
  // Notes are prefixed with their ecosystem: "the root pom only" means nothing
  // in a report that also covers npm.
  const notes = facts.flatMap((f) => (f.notes ?? []).map((n) => `${f.ecosystem}: ${n}`))
  const plan = buildPlan({ updates, config, alerts, unmanageable, capabilities, notes })

  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
}

// Only run as a CLI when invoked directly, so the tests can import buildPlan.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`plan.mjs: ${err.message}\n`)
    process.exit(2)
  })
}
