// Agent harness for the pre-publish review step.
//
// Everything in this file exists to bound what an unattended agent can do. The
// step merges pull requests without a person looking first, so the limits have
// to live in code that the agent does not write and cannot talk its way past.
// A prompt that asks an agent not to touch a file is not a limit.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// Directories a fix agent may change. A scraper bug, a merge bug, an enricher
// bug and their tests all live here. Everything else is refused before a human
// or a reviewing agent ever sees the pull request, which is what keeps a 3am
// change out of crossingDetector.js, out of supabase/migrations, and out of the
// instructions the agents themselves read.
export const ALLOWED_FIX_PATHS = [
  'backend/src/scrapers/',
  'backend/src/lib/',
  'backend/scripts/',
  'backend/test/',
  'enricher/',
]

// Refused even though the prefixes above would otherwise allow them. The
// orchestrator is the code that enforces the rails, so an agent that edits it
// removes the rails.
export const DENIED_FIX_PATHS = [
  'backend/scripts/lib/reviewAgents.js',
  'backend/scripts/run-prepublish-review.js',
]

export function isPathAllowed(file) {
  if (typeof file !== 'string' || file === '') return false
  // Absolute paths and traversal escape the repository, so they never match a
  // prefix check in the way the check intends.
  if (file.startsWith('/') || file.includes('..')) return false
  if (DENIED_FIX_PATHS.includes(file)) return false
  return ALLOWED_FIX_PATHS.some((prefix) => file.startsWith(prefix))
}

export function checkDiffPaths(files) {
  const violations = files.filter((f) => !isPathAllowed(f))
  return { ok: violations.length === 0, violations }
}

// A diagnose agent reports how many other rows carry the same defect. It does
// NOT write the query. The Supabase client speaks PostgREST rather than SQL, and
// a structured filter that the orchestrator turns into a counting request has no
// place for a second statement to hide. The agent describes the rows; this code
// decides what that means.
export const ALLOWED_FILTER_OPS = new Set(['eq', 'neq', 'is', 'gt', 'gte', 'lt', 'lte', 'ilike'])

export function isCountableTable(table) {
  if (typeof table !== 'string') return false
  if (table === 'scraper_all' || table === 'calendar_events') return true
  return /^scraper_[a-z0-9]+$/.test(table)
}

export function validateBlastRadius(radius) {
  if (!radius || typeof radius !== 'object') return { ok: false, error: 'missing' }
  if (!isCountableTable(radius.table)) return { ok: false, error: `table not countable: ${radius.table}` }
  if (!Array.isArray(radius.filters) || radius.filters.length === 0) {
    return { ok: false, error: 'no filters' }
  }
  if (radius.filters.length > 8) return { ok: false, error: 'too many filters' }
  for (const f of radius.filters) {
    if (!f || typeof f.column !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(f.column)) {
      return { ok: false, error: `bad column: ${f?.column}` }
    }
    if (!ALLOWED_FILTER_OPS.has(f.op)) return { ok: false, error: `bad op: ${f?.op}` }
  }
  return { ok: true }
}

// Returns the number of rows that share the defect, or null when the filter was
// refused or the request failed. A count that cannot be taken is reported as
// unknown, never as zero: zero would read as "this defect affects one event".
export async function countBlastRadius(supabase, radius) {
  const check = validateBlastRadius(radius)
  if (!check.ok) return { count: null, error: check.error }
  let query = supabase.from(radius.table).select('*', { count: 'exact', head: true })
  for (const f of radius.filters) {
    query = query[f.op](f.column, f.value)
  }
  if (radius.future_only) query = query.gte('date', new Date().toISOString().slice(0, 10))
  const { count, error } = await query
  if (error) return { count: null, error: error.message }
  return { count, error: null }
}

// Credentials a diagnose agent has no use for. It reads the repository and
// fetches pages from event websites. It never reaches the database, because the
// orchestrator has already put the rows it needs into the prompt.
const STRIPPED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'DATABASE_URL',
  'SENDGRID_API_KEY',
  'SMSAPI_TOKEN',
  'BRAVE_SEARCH_API_KEY',
]

export function sanitizedEnv(base = process.env) {
  const env = { ...base }
  for (const key of STRIPPED_ENV) delete env[key]
  return env
}

// A candidate is only diagnosable when it names the source row it came from.
// Three of the four layers the method traces — scraper_all, scraper_<source> and
// the calendar_events row — are keyed on source + source_id, and the scraper file
// the diagnose agent is told to read is named after the source. Without it the
// agent runs on one layer instead of four and is pointed at a file that does not
// exist, which is how a pull request against sources/undefined.js got opened on
// 2026-09-14. Hold those candidates back for a person instead.
export function partitionCandidates(candidates) {
  const diagnosable = []
  const undiagnosable = []
  for (const c of candidates || []) {
    const source = typeof c?.source === 'string' ? c.source.trim() : ''
    const sourceId = c?.source_id == null ? '' : String(c.source_id).trim()
    if (source && sourceId) diagnosable.push(c)
    else undiagnosable.push({ candidate: c, reason: !source ? 'no source on the publish row' : 'no source_id on the publish row' })
  }
  return { diagnosable, undiagnosable }
}

// The file a diagnose agent names is input, not fact. It has to be a path a fix
// agent would be allowed to touch anyway, and it has to exist — an agent that
// invents a filename would otherwise get a worktree, a branch and a pull request
// named after it.
export function isUsableDefectFile(file, { exists = (f) => existsSync(path.join(REPO_ROOT, f)) } = {}) {
  if (!isPathAllowed(file)) return false
  return exists(file)
}

// Two findings belong to the same defect when they name the same layer and the
// same file. Grouping on the file the agents themselves named needs no model
// call, and it is the answer anyway: one file, one fix, one pull request.
export function defectKey(finding) {
  const layer = String(finding?.defect?.layer || 'unknown').toLowerCase()
  const file = String(finding?.defect?.file || 'unknown')
  return `${layer}:${file}`
}

export function groupFindings(findings, opts = {}) {
  const groups = new Map()
  for (const finding of findings) {
    if (finding?.verdict !== 'code-defect') continue
    if (!isUsableDefectFile(finding?.defect?.file, opts)) continue
    const key = defectKey(finding)
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        layer: finding.defect.layer,
        file: finding.defect.file,
        findings: [],
        events: [],
        signatures: new Set(),
      })
    }
    const group = groups.get(key)
    group.findings.push(finding)
    group.events.push(finding.event)
    if (finding.defect.signature) group.signatures.add(finding.defect.signature)
  }
  return [...groups.values()]
    .map((g) => ({ ...g, signatures: [...g.signatures] }))
    .sort((a, b) => b.findings.length - a.findings.length)
}

// A slug for the branch name. Branches are shared with a person, so they have to
// stay readable and they have to stay unique per defect.
export function branchSlug(key) {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// The model returns prose around its JSON often enough that a bare JSON.parse
// fails on answers that are otherwise correct. Take the outermost braces.
export function parseAgentJson(text) {
  if (typeof text !== 'string') return null
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '')
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first === -1 || last <= first) return null
  try {
    return JSON.parse(cleaned.slice(first, last + 1))
  } catch {
    return null
  }
}

// `claude -p` in a script has to run without this repository's settings.
// Otherwise its hooks and its permission rules apply to the subprocess and
// rewrite or block the output the caller is trying to parse. The isolation also
// drops the settings-based tool allowlist, which is why every call passes
// --allowedTools explicitly.
export function runAgent({
  prompt,
  cwd,
  allowedTools,
  model = 'sonnet',
  timeoutMs = 15 * 60 * 1000,
  env = sanitizedEnv(),
}) {
  return new Promise((resolve) => {
    const args = [
      '-p',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--allowedTools', allowedTools.join(','),
      '--model', model,
      '--output-format', 'json',
    ]
    const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `spawn failed: ${err.message}`, json: null, costUsd: 0 })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        resolve({ ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s`, json: null, costUsd: 0 })
        return
      }
      if (code !== 0) {
        resolve({ ok: false, error: `claude exited ${code}: ${stderr.slice(0, 300)}`, json: null, costUsd: 0 })
        return
      }
      let envelope
      try {
        envelope = JSON.parse(stdout)
      } catch {
        resolve({ ok: false, error: 'claude did not return JSON', json: null, costUsd: 0, raw: stdout.slice(0, 500) })
        return
      }
      resolve({
        ok: true,
        json: parseAgentJson(envelope.result || ''),
        raw: envelope.result || '',
        costUsd: envelope.total_cost_usd || 0,
        durationMs: envelope.duration_ms || 0,
      })
    })

    child.stdin.end(prompt)
  })
}

// Run at most `limit` agents at a time. Forty read-only agents at once would
// exhaust the API rate limit and make every one of them slower.
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
