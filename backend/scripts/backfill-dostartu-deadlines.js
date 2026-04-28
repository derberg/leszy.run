#!/usr/bin/env node

/**
 * One-time backfill: refresh registration_deadline for all dostartu events
 * (future events only) on both scraper_all and calendar_events.
 *
 * Source of truth: dostartu API
 *   1. max(classifications[].classificationPrices[].endedTime)  → date
 *   2. competition.provisionTime                                → date
 *   3. competition.endDate                                      → date  (legacy field, usually null)
 *
 * Overwrites existing values. Does NOT respect calendar_events.locked_fields
 * (per user instruction for this one-shot fix). Logs every event where no
 * deadline could be determined.
 *
 * Usage:
 *   cd backend && node --env-file=../.env scripts/backfill-dostartu-deadlines.js          # dry-run
 *   cd backend && node --env-file=../.env scripts/backfill-dostartu-deadlines.js --apply  # write
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const API_URL = 'https://api.dostartu.pl'
const HEADERS = { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' }
const RATE_LIMIT_MS = 400

const dryRun = !process.argv.includes('--apply')
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function toDate(iso) {
  if (!iso || typeof iso !== 'string') return null
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return res.json()
}

async function computeDeadline(sourceId) {
  let classifications = []
  let provisionTime = null
  let endDate = null

  try {
    const j = await fetchJson(`${API_URL}/competitions/${sourceId}/classifications`)
    classifications = j.classifications || []
  } catch (err) {
    // continue — try competition endpoint anyway
  }

  // Find latest endedTime across all price tiers
  let latestEndedTime = null
  for (const c of classifications) {
    const prices = c.classificationPrices || []
    for (const p of prices) {
      if (p.endedTime && (!latestEndedTime || p.endedTime > latestEndedTime)) {
        latestEndedTime = p.endedTime
      }
    }
  }

  let source = null
  let value = toDate(latestEndedTime)
  if (value) source = 'classification'

  if (!value) {
    // Fallback to top-level fields
    try {
      const j = await fetchJson(`${API_URL}/competitions/${sourceId}`)
      provisionTime = j.competition?.provisionTime || null
      endDate = j.competition?.endDate || null
    } catch {}

    value = toDate(provisionTime)
    if (value) source = 'provisionTime'

    if (!value) {
      value = toDate(endDate)
      if (value) source = 'endDate'
    }
  }

  return { value, source, debug: { latestEndedTime, provisionTime, endDate } }
}

async function fetchAllPaged(table, query) {
  const rows = []
  let from = 0
  const pageSize = 1000
  while (true) {
    const { data, error } = await query.range(from, from + pageSize - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }
  return rows
}

async function main() {
  console.log(dryRun ? '=== DRY RUN (use --apply to write) ===\n' : '=== APPLYING UPDATES ===\n')

  const today = new Date().toISOString().split('T')[0]

  // Pull all future dostartu rows from both tables
  const calendarRows = await fetchAllPaged(
    'calendar_events',
    supabase.from('calendar_events')
      .select('id, source_id, name, date, registration_deadline')
      .eq('source', 'dostartu')
      .gte('date', today)
      .order('date', { ascending: true }),
  )
  const scraperAllRows = await fetchAllPaged(
    'scraper_all',
    supabase.from('scraper_all')
      .select('id, source, source_id, source_links, name, date, registration_deadline')
      .gte('date', today)
      .filter('source_links', 'cs', JSON.stringify([{ source: 'dostartu' }])),
  )

  console.log(`calendar_events (future, dostartu): ${calendarRows.length}`)
  console.log(`scraper_all (future, dostartu in source_links): ${scraperAllRows.length}\n`)

  // Build a unique set of dostartu source_ids to query
  const sourceIds = new Set()
  for (const r of calendarRows) if (r.source_id) sourceIds.add(String(r.source_id))
  for (const r of scraperAllRows) {
    if (r.source === 'dostartu' && r.source_id) {
      sourceIds.add(String(r.source_id))
    } else if (Array.isArray(r.source_links)) {
      const link = r.source_links.find(l => l.source === 'dostartu')
      if (link?.source_id) sourceIds.add(String(link.source_id))
    }
  }

  console.log(`Unique dostartu source_ids to query: ${sourceIds.size}\n`)

  // Fetch deadlines for each source_id (rate-limited)
  const deadlineMap = new Map()
  const noDeadline = []
  let i = 0
  for (const sid of sourceIds) {
    i++
    try {
      const result = await computeDeadline(sid)
      deadlineMap.set(sid, result)
      if (!result.value) {
        noDeadline.push({ sourceId: sid, debug: result.debug })
      }
      if (i % 25 === 0 || i === sourceIds.size) {
        console.log(`  fetched ${i}/${sourceIds.size}`)
      }
    } catch (err) {
      console.log(`  ERR ${sid}: ${err.message}`)
      deadlineMap.set(sid, { value: null, source: 'error', debug: { error: err.message } })
      noDeadline.push({ sourceId: sid, debug: { error: err.message } })
    }
    await sleep(RATE_LIMIT_MS)
  }

  // Apply to calendar_events
  let calChanged = 0, calSame = 0, calNoData = 0, calErrors = 0
  const calLog = []
  for (const row of calendarRows) {
    const sid = String(row.source_id)
    const result = deadlineMap.get(sid)
    if (!result || !result.value) {
      calNoData++
      calLog.push({ kind: 'no-deadline', name: row.name, sourceId: sid, oldValue: row.registration_deadline })
      continue
    }
    if (row.registration_deadline === result.value) {
      calSame++
      continue
    }
    calLog.push({
      kind: 'change',
      name: row.name,
      sourceId: sid,
      oldValue: row.registration_deadline,
      newValue: result.value,
      source: result.source,
    })
    if (!dryRun) {
      const { error } = await supabase
        .from('calendar_events')
        .update({ registration_deadline: result.value })
        .eq('id', row.id)
      if (error) { calErrors++; console.log(`  ERR cal ${row.id}: ${error.message}`) }
      else calChanged++
    } else {
      calChanged++
    }
  }

  // Apply to scraper_all
  let saChanged = 0, saSame = 0, saNoData = 0, saErrors = 0
  for (const row of scraperAllRows) {
    let sid = null
    if (row.source === 'dostartu') sid = String(row.source_id)
    else {
      const link = (row.source_links || []).find(l => l.source === 'dostartu')
      sid = link ? String(link.source_id) : null
    }
    if (!sid) continue
    const result = deadlineMap.get(sid)
    if (!result || !result.value) { saNoData++; continue }
    if (row.registration_deadline === result.value) { saSame++; continue }

    if (!dryRun) {
      const { error } = await supabase
        .from('scraper_all')
        .update({ registration_deadline: result.value })
        .eq('id', row.id)
      if (error) { saErrors++; console.log(`  ERR sa ${row.id}: ${error.message}`) }
      else saChanged++
    } else {
      saChanged++
    }
  }

  // Print per-event log for calendar_events (the public-facing table)
  console.log('\n--- calendar_events log ---')
  for (const e of calLog) {
    if (e.kind === 'change') {
      console.log(`  ${e.sourceId.padStart(6)}  ${(e.oldValue || '(null)').padEnd(11)} → ${e.newValue}  [${e.source}]  ${e.name}`)
    } else if (e.kind === 'no-deadline') {
      console.log(`  ${e.sourceId.padStart(6)}  NO DEADLINE  (kept ${e.oldValue || 'null'})  ${e.name}`)
    }
  }

  console.log('\n--- Summary ---')
  console.log(`calendar_events:  changed=${calChanged}  unchanged=${calSame}  no-deadline=${calNoData}  errors=${calErrors}`)
  console.log(`scraper_all:      changed=${saChanged}  unchanged=${saSame}  no-deadline=${saNoData}  errors=${saErrors}`)
  console.log(`\nEvents with NO deadline returned by API: ${noDeadline.length}`)
  if (noDeadline.length > 0) {
    console.log('  source_ids:', noDeadline.map(n => n.sourceId).join(', '))
  }
  if (dryRun) console.log('\n(DRY RUN — no changes written. Re-run with --apply.)')
}

main().catch(err => { console.error(err); process.exit(1) })
