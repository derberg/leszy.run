// Writes the functions env file for a sandbox run: the mock-stack base (tests/registration/functions.env,
// for the e-mail capture and the jobs secret) with every DPAY_* value replaced by the sandbox's, and
// DPAY_IPN_URL set to the public tunnel. Usage: node write-functions-env.js <output path>
// The file holds the sandbox secret: write it OUTSIDE the repository (CI uses $RUNNER_TEMP) and never commit it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sandboxConfig } from './guard.js'

const out = process.argv[2]
if (!out) throw new Error('usage: node write-functions-env.js <output path>')
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
if (path.resolve(out).startsWith(repoRoot + path.sep)) throw new Error('refusing to write secrets inside the repository')

const cfg = sandboxConfig()
const base = fs.readFileSync(path.join(repoRoot, 'tests/registration/functions.env'), 'utf8')
  .split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('DPAY_'))
const lines = [
  ...base,
  `DPAY_SERVICE=${cfg.service}`, `DPAY_SECRET=${cfg.secret}`, `DPAY_API_BASE=${cfg.apiBase}`,
  `DPAY_PANEL_BASE=${cfg.panelBase}`, `DPAY_IPN_URL=${cfg.ipnUrl}`,
]
fs.writeFileSync(out, `${lines.join('\n')}\n`, { mode: 0o600 })
console.log(`wrote ${lines.length} settings to ${out} (values not printed)`)
