// The npm ecosystem rules this adapter owns, and core deliberately does not:
// how a version bump is classified, what counts as a prerelease, and which
// packages belong to one family (and so become one atomic element upstream).
//
// It lives in its own file rather than inline in `discover` so it can be unit
// tested - these rules decide what gets batched together and what never enters
// tier 1, and both are invisible when wrong.
//
// Plain CommonJS with no dependencies: `discover` requires it directly, and the
// tests import it.

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

/**
 * Strip an npm range operator down to a plain version: "^9.5.1" -> "9.5.1".
 * An unusual range such as "1.x" survives unchanged and then classifies as
 * `unknown` - the conservative direction, since core keeps unknown bumps out of
 * the tier-1 batch.
 */
function bareVersion(range) {
  return String(range).replace(/^[^0-9]*/, '')
}

/**
 * The operator `bareVersion` strips: "^9.5.1" -> "^". The exact inverse, so
 * `rangePrefix(r) + bareVersion(r) === r` for every range.
 *
 * `apply` re-attaches it, because the run updates versions and must not quietly
 * change a repo's pinning policy: a package deliberately pinned exactly stays
 * pinned exactly, and a caret range stays a caret range.
 */
function rangePrefix(range) {
  return /^[^0-9]*/.exec(String(range ?? ''))[0]
}

/**
 * Splits an element id into the package and the version it pins.
 *
 * npm's element id is `name@version` - the version is part of the id precisely
 * so `apply` cannot re-resolve `latest`. Splitting on the LAST `@` keeps scoped
 * names intact: "@mantine/core@9.5.1" -> { "@mantine/core", "9.5.1" }.
 *
 * Returns null for anything that is not a versioned id, including a bare
 * package name; `apply` turns that into exit 2 rather than guessing a version.
 */
function parseElementId(id) {
  const s = String(id ?? '')
  const at = s.lastIndexOf('@')
  // at === 0 is a scope marker with no version ("@types/node"), not a split.
  if (at <= 0) return null
  const name = s.slice(0, at)
  const version = s.slice(at + 1)
  if (!name || !version) return null
  return { name, version }
}

/** The section of `pkg` that declares `name`, or null. */
function sectionOf(pkg, name) {
  return SECTIONS.find((s) => pkg[s] && pkg[s][name] !== undefined) ?? null
}

/** The bare version the manifest currently declares for `name`, or null. */
function declaredVersion(pkg, name) {
  const section = sectionOf(pkg, name)
  return section ? bareVersion(pkg[section][name]) : null
}

/**
 * Writes each planned version into `pkg` in place, keeping the declared range
 * operator, and reports what it could and could not find.
 *
 * A name the manifest does not declare is skipped rather than added: adding it
 * would invent a dependency, and skipping leaves the manifest byte-identical so
 * `apply` exits 4 - the contract's signal that an element id matched nothing.
 */
function applyVersions(pkg, entries) {
  const applied = []
  const missing = []

  for (const { name, version } of entries) {
    const section = sectionOf(pkg, name)
    if (!section) {
      missing.push(name)
      continue
    }
    pkg[section][name] = rangePrefix(pkg[section][name]) + version
    applied.push({ name, to: version, section })
  }

  return { applied, missing }
}

/**
 * The indentation a manifest is written with, so rewriting it produces a
 * one-line diff instead of reformatting the whole file. `npm pkg set` is not
 * used for the same reason: it re-sorts dependency keys, and the deps branch is
 * supposed to be a clean deps-only diff.
 */
function detectIndent(raw) {
  const m = /\n([ \t]+)"/.exec(String(raw ?? ''))
  return m ? m[1] : '  '
}

/** patch | minor | major | unknown. */
function semverBump(from, to) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const a = parse(from)
  const b = parse(to)
  if (!a || !b) return 'unknown'
  if (a[0] !== b[0]) return 'major'
  if (a[1] !== b[1]) return 'minor'
  return 'patch'
}

/**
 * Is this an RC/alpha/beta/canary the run must not adopt on its own?
 * A hyphen followed only by digits is build metadata (1.2.3-1), not a
 * prerelease nobody chose.
 */
function isPrerelease(version) {
  return /-[^-]*[a-z]/i.test(String(version ?? '').trim())
}

/**
 * The npm scope of a package, or null. `@types` is deliberately excluded: it is
 * a namespace of unrelated type stubs, not a library family, so scope-grouping
 * it would make one failure revert every unrelated stub. The pkg/@types/pkg
 * rule below already pairs stubs with the package they describe.
 */
function npmScope(name) {
  if (!name.startsWith('@')) return null
  const scope = name.split('/')[0]
  return scope === '@types' ? null : scope
}

/**
 * The package a types stub describes, or null.
 * `@types/lodash` -> `lodash`; `@types/mantine__core` -> `@mantine/core`.
 */
function typesBaseOf(name) {
  if (!name.startsWith('@types/')) return null
  const stub = name.slice('@types/'.length)
  const [scope, pkg] = stub.split('__')
  return pkg ? `@${scope}/${pkg}` : stub
}

/**
 * Assigns `family` to each update in place and returns the same array.
 *
 * Two npm relationships make packages inseparable: everything under one scope
 * is released together, and a types stub is meaningless apart from the package
 * it describes. Core unions updates sharing a family and applies, gates, and
 * reverts them as one element.
 *
 * A family of one stays null. Naming a lone package after its scope
 * ("@playwright") would make it unidentifiable in the PR table and in the apply
 * command.
 */
function assignFamilies(updates) {
  const parent = updates.map((_, i) => i)
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (a, b) => {
    const [ra, rb] = [find(a), find(b)]
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }

  const indexOfName = new Map(updates.map((u, i) => [u.name, i]))

  const firstOfScope = new Map()
  updates.forEach((u, i) => {
    const scope = npmScope(u.name)
    if (!scope) return
    if (firstOfScope.has(scope)) union(firstOfScope.get(scope), i)
    else firstOfScope.set(scope, i)
  })

  updates.forEach((u, i) => {
    const base = typesBaseOf(u.name)
    if (base !== null && indexOfName.has(base)) union(indexOfName.get(base), i)
  })

  const sets = new Map()
  updates.forEach((u, i) => {
    const root = find(i)
    if (!sets.has(root)) sets.set(root, [])
    sets.get(root).push(u)
  })

  for (const members of sets.values()) {
    if (members.length < 2) {
      for (const m of members) m.family = null
      continue
    }

    // A shared scope is the readable name for the family; mixed sets (a scoped
    // package plus its @types stub) fall back to the shortest member name.
    const scopes = new Set(members.map((m) => npmScope(m.name)))
    const shared = scopes.size === 1 ? [...scopes][0] : null
    const shortest = members
      .map((m) => m.name)
      .sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
    const family = shared ?? shortest

    for (const m of members) m.family = family
  }

  return updates
}

/**
 * Turns ncu's `{name: newRange}` map plus the manifest into contract-shaped
 * update facts. ncu reports the new *range* per package, so the currently
 * declared range supplies `from`.
 */
function buildUpdates(pkg, upgraded) {
  const currentRange = (name) => {
    for (const s of SECTIONS) if (pkg[s] && pkg[s][name] !== undefined) return pkg[s][name]
    return null
  }

  const updates = Object.entries(upgraded)
    .map(([name, toRange]) => {
      const fromRange = currentRange(name)
      // ncu saw it somewhere we did not; skip rather than guess.
      if (fromRange === null) return null
      const from = bareVersion(fromRange)
      const to = bareVersion(toRange)
      return {
        // The version is part of the id so `apply` pins exactly what was
        // discovered here, rather than re-resolving `latest` and quietly taking
        // a release that landed between discovery and apply.
        id: `${name}@${to}`,
        name,
        from,
        to,
        bump: semverBump(from, to),
        prerelease: isPrerelease(to),
        mechanism: 'npm',
        family: null,
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name))

  return assignFamilies(updates)
}

module.exports = {
  SECTIONS,
  applyVersions,
  assignFamilies,
  bareVersion,
  buildUpdates,
  declaredVersion,
  detectIndent,
  isPrerelease,
  npmScope,
  parseElementId,
  rangePrefix,
  sectionOf,
  semverBump,
  typesBaseOf,
}
