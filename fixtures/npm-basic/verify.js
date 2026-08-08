// The fixture's gate: proves the installed tree resolves, nothing more.
// Deliberately uses require.resolve rather than require, so the check stays
// meaningful after an update moves a package from CommonJS to ESM-only.
const assert = require("node:assert")

for (const name of ["ms", "escape-string-regexp"]) {
  assert.ok(require.resolve(name), `${name} did not resolve`)
}

console.log("npm-basic fixture verify: ok")
