import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPathAllowed,
  checkDiffPaths,
  isCountableTable,
  validateBlastRadius,
  sanitizedEnv,
  defectKey,
  groupFindings,
  branchSlug,
  parseAgentJson,
  mapWithConcurrency,
} from '../scripts/lib/reviewAgents.js'

// The path allowlist is the limit that keeps an unattended merge survivable, so
// it gets tested the way a permission check gets tested.
test('a scraper, lib, script, test or enricher file is allowed', () => {
  for (const f of [
    'backend/src/scrapers/sources/b4sport.js',
    'backend/src/lib/pickRegulaminUrl.js',
    'backend/scripts/run-merge.js',
    'backend/test/b4sportSkip.test.js',
    'enricher/enricher/steps/verify.py',
  ]) {
    assert.equal(isPathAllowed(f), true, f)
  }
})

test('everything outside those directories is refused', () => {
  for (const f of [
    'backend/src/mqtt/crossingDetector.js',
    'backend/src/db/schema.js',
    'supabase/migrations/0001_init.sql',
    'supabase/functions/get-club/index.js',
    '.github/workflows/supabase-release.yml',
    'CLAUDE.md',
    'package.json',
    'frontend/src/pages/CalendarEventsList.jsx',
    'packages/ui/src/lib/positionEstimation.js',
  ]) {
    assert.equal(isPathAllowed(f), false, f)
  }
})

test('an agent may not edit the code that enforces the rails', () => {
  assert.equal(isPathAllowed('backend/scripts/lib/reviewAgents.js'), false)
  assert.equal(isPathAllowed('backend/scripts/run-prepublish-review.js'), false)
})

test('absolute paths and traversal are refused', () => {
  assert.equal(isPathAllowed('/etc/passwd'), false)
  assert.equal(isPathAllowed('backend/scripts/../../../etc/passwd'), false)
  assert.equal(isPathAllowed('backend/src/lib/../../db/schema.js'), false)
  assert.equal(isPathAllowed(''), false)
  assert.equal(isPathAllowed(null), false)
})

test('checkDiffPaths names every offending file', () => {
  const r = checkDiffPaths([
    'backend/src/scrapers/sources/foxter.js',
    'CLAUDE.md',
    'supabase/migrations/9.sql',
  ])
  assert.equal(r.ok, false)
  assert.deepEqual(r.violations, ['CLAUDE.md', 'supabase/migrations/9.sql'])
})

// The agent describes which rows share the defect. It never writes a query, so
// the guard is a shape check rather than a parser.
test('scraper tables and calendar_events are countable, nothing else is', () => {
  for (const t of ['scraper_all', 'calendar_events', 'scraper_b4sport', 'scraper_zapisyonline']) {
    assert.equal(isCountableTable(t), true, t)
  }
  for (const t of ['participants', 'results', 'gate_events', 'club_membership_log', 'pg_class', '', null]) {
    assert.equal(isCountableTable(t), false, String(t))
  }
})

test('a well-formed blast radius passes', () => {
  const r = validateBlastRadius({
    table: 'scraper_all',
    filters: [
      { column: 'source', op: 'eq', value: 'b4sport' },
      { column: 'regulamin_url', op: 'is', value: null },
    ],
    future_only: true,
  })
  assert.equal(r.ok, true)
})

test('an unknown table, operator or column shape is refused', () => {
  assert.equal(validateBlastRadius({ table: 'participants', filters: [{ column: 'a', op: 'eq' }] }).ok, false)
  assert.equal(validateBlastRadius({ table: 'scraper_all', filters: [{ column: 'a', op: 'rpc' }] }).ok, false)
  assert.equal(validateBlastRadius({ table: 'scraper_all', filters: [{ column: 'a; drop table x', op: 'eq' }] }).ok, false)
  assert.equal(validateBlastRadius({ table: 'scraper_all', filters: [] }).ok, false)
  assert.equal(validateBlastRadius(null).ok, false)
})

test('the service-role key never reaches a diagnose agent', () => {
  const env = sanitizedEnv({
    PATH: '/usr/bin',
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'secret',
    DATABASE_URL: 'postgres://x',
    SENDGRID_API_KEY: 'sg',
    HOME: '/home/x',
  })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/x')
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'SENDGRID_API_KEY']) {
    assert.equal(k in env, false, k)
  }
})

const finding = (file, layer, event, verdict = 'code-defect') => ({
  verdict,
  event: { name: event, source: 'b4sport', source_id: '1' },
  defect: { layer, file, signature: `${file} lost the field` },
})

test('findings on one file collapse into one defect', () => {
  const groups = groupFindings([
    finding('backend/src/scrapers/sources/b4sport.js', 'scraper', 'A'),
    finding('backend/src/scrapers/sources/b4sport.js', 'scraper', 'B'),
    finding('backend/src/scrapers/index.js', 'merge', 'C'),
  ])
  assert.equal(groups.length, 2)
  assert.equal(groups[0].findings.length, 2)
  assert.deepEqual(groups[0].events.map((e) => e.name), ['A', 'B'])
})

test('the same file at a different layer is a different defect', () => {
  const groups = groupFindings([
    finding('backend/src/scrapers/index.js', 'merge', 'A'),
    finding('backend/src/scrapers/index.js', 'publish', 'B'),
  ])
  assert.equal(groups.length, 2)
})

// An event whose data is simply not published anywhere is not a bug, and it must
// not reach a fix agent.
test('absent-at-source and needs-human findings are not fixed', () => {
  const groups = groupFindings([
    finding('backend/src/scrapers/sources/x.js', 'scraper', 'A', 'absent-at-source'),
    finding('backend/src/scrapers/sources/y.js', 'scraper', 'B', 'needs-human'),
  ])
  assert.deepEqual(groups, [])
})

test('defectKey is stable and case-insensitive on the layer', () => {
  assert.equal(
    defectKey({ defect: { layer: 'Scraper', file: 'a.js' } }),
    defectKey({ defect: { layer: 'scraper', file: 'a.js' } })
  )
  assert.equal(defectKey({}), 'unknown:unknown')
})

test('branchSlug produces a usable git branch fragment', () => {
  assert.equal(
    branchSlug('scraper:backend/src/scrapers/sources/b4sport.js'),
    'scraper-backend-src-scrapers-sources-b4sport-js'
  )
  assert.equal(branchSlug('a'.repeat(200)).length, 60)
})

test('JSON is recovered from an answer wrapped in prose or a fence', () => {
  assert.deepEqual(parseAgentJson('Here you go:\n```json\n{"a":1}\n```\nhope that helps'), { a: 1 })
  assert.deepEqual(parseAgentJson('{"a":{"b":2}}'), { a: { b: 2 } })
  assert.equal(parseAgentJson('no json here'), null)
  assert.equal(parseAgentJson('{broken'), null)
})

test('mapWithConcurrency keeps order and respects the limit', async () => {
  let running = 0
  let peak = 0
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 5))
    running--
    return n * 2
  })
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14])
  assert.ok(peak <= 3, `peak concurrency ${peak}`)
})
