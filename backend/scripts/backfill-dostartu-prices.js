#!/usr/bin/env node

/**
 * Backfill registration_deadline + price_from + price_to for dostartu events
 * across scraper_dostartu, scraper_all, and pending calendar_events.
 *
 * Reuses the same field-extraction logic the scraper now uses (see
 * src/scrapers/sources/dostartu.js → parseClassifications):
 *   - registration_deadline: max(classificationPrices.endedTime) → provisionTime → endDate
 *   - price_from / price_to: min/max across all classificationPrices.price
 *     for adult classifications (kids tiers excluded in mixed events to avoid
 *     a kids-100m-at-20-PLN dominating an adult marathon at 100 PLN)
 *
 * Usage:
 *   cd backend && node --env-file=../.env scripts/backfill-dostartu-prices.js          # dry-run
 *   cd backend && node --env-file=../.env scripts/backfill-dostartu-prices.js --apply  # write
 *
 * Default scope: all future dostartu events. Pass --pending-only to limit
 * calendar_events updates to status='pending' rows (recommended for first run
 * so admin-curated 'active' rows are not overwritten).
 */

import { createClient } from '@supabase/supabase-js'
import { fetchClassifications, parseClassifications } from '../src/scrapers/sources/dostartu.js'

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
const pendingOnly = process.argv.includes('--pending-only')
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const toDate = (iso) => {
  if (!iso || typeof iso !== 'string') return null
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return res.json()
}

async function fetchEventData(sourceId, eventName) {
  // Pull both endpoints in sequence to mirror what the scraper does live.
  let competition = null
  try {
    const j = await fetchJson(`${API_URL}/competitions/${sourceId}`)
    competition = j.competition || null
  } catch {}

  const classifications = await fetchClassifications(sourceId)
  const parsed = parseClassifications(classifications, eventName || '')

  const deadlineIso = parsed.latestEndedTime || competition?.provisionTime || competition?.endDate
  return {
    registration_deadline: toDate(deadlineIso) || null,
    price_from: parsed.priceFrom,
    price_to: parsed.priceTo,
  }
}

async function fetchAllPaged(_label, query) {
  const rows = []
  let from = 0
  const pageSize = 1000
  while (true) {
    const { data, error } = await query.range(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }
  return rows
}

function diffNeedsUpdate(existing, fresh) {
  const updates = {}
  for (const k of ['registration_deadline', 'price_from', 'price_to']) {
    const newVal = fresh[k]
    if (newVal === null || newVal === undefined) continue
    // Coerce existing numeric (may come back as string from PostgREST) for comparison
    const oldVal = (k === 'price_from' || k === 'price_to') && existing[k] != null
      ? Number(existing[k])
      : existing[k]
    if (oldVal !== newVal) updates[k] = newVal
  }
  return updates
}

async function main() {
  console.log(dryRun ? '=== DRY RUN (use --apply to write) ===\n' : '=== APPLYING UPDATES ===\n')
  if (pendingOnly) console.log('(--pending-only: calendar_events updates limited to status=pending)\n')

  const today = new Date().toISOString().split('T')[0]

  const sdRows = await fetchAllPaged('scraper_dostartu',
    supabase.from('scraper_dostartu')
      .select('id, source_id, name, date, registration_deadline, price_from, price_to')
      .gte('date', today),
  )
  const saRows = await fetchAllPaged('scraper_all',
    supabase.from('scraper_all')
      .select('id, source, source_id, source_links, name, date, registration_deadline, price_from, price_to')
      .gte('date', today)
      .filter('source_links', 'cs', JSON.stringify([{ source: 'dostartu' }])),
  )

  let calQuery = supabase.from('calendar_events')
    .select('id, source, source_id, name, date, status, registration_deadline, price_from, price_to, locked_fields')
    .eq('source', 'dostartu')
    .gte('date', today)
  if (pendingOnly) calQuery = calQuery.eq('status', 'pending')
  const ceRows = await fetchAllPaged('calendar_events', calQuery)

  console.log(`scraper_dostartu (future):                       ${sdRows.length}`)
  console.log(`scraper_all (future, with dostartu source_link): ${saRows.length}`)
  console.log(`calendar_events (future, dostartu${pendingOnly ? ', pending' : ''}):           ${ceRows.length}\n`)

  // Build set of all dostartu source_ids we need to refresh from the API.
  const sourceIds = new Set()
  for (const r of sdRows) if (r.source_id) sourceIds.add(String(r.source_id))
  for (const r of saRows) {
    if (r.source === 'dostartu' && r.source_id) sourceIds.add(String(r.source_id))
    else {
      const link = (r.source_links || []).find(l => l.source === 'dostartu')
      if (link?.source_id) sourceIds.add(String(link.source_id))
    }
  }
  for (const r of ceRows) if (r.source_id) sourceIds.add(String(r.source_id))

  console.log(`Unique dostartu source_ids to query: ${sourceIds.size}\n`)

  // Fetch fresh data from API
  const fresh = new Map()
  const apiErrors = []
  let i = 0
  for (const sid of sourceIds) {
    i++
    try {
      // We don't have the name here for some IDs; pass empty (parseClassifications
      // only uses name to detect kids when no playerType is set).
      const data = await fetchEventData(sid, '')
      fresh.set(sid, data)
    } catch (err) {
      apiErrors.push({ sourceId: sid, message: err.message })
    }
    if (i % 25 === 0 || i === sourceIds.size) console.log(`  fetched ${i}/${sourceIds.size}`)
    await sleep(RATE_LIMIT_MS)
  }

  // Apply updates
  const summary = { sd: 0, sa: 0, ce: 0, errors: 0 }
  const ceLog = []

  async function applyUpdates(table, rows, getSid) {
    let updated = 0
    for (const row of rows) {
      const sid = getSid(row)
      if (!sid) continue
      const f = fresh.get(sid)
      if (!f) continue

      // For calendar_events: respect locked_fields
      const locked = Array.isArray(row.locked_fields) ? new Set(row.locked_fields) : new Set()
      const updates = diffNeedsUpdate(row, f)
      for (const k of Object.keys(updates)) {
        if (locked.has(k)) delete updates[k]
      }
      if (Object.keys(updates).length === 0) continue

      if (table === 'calendar_events') {
        ceLog.push({
          sid,
          name: row.name,
          updates,
          old: { d: row.registration_deadline, pf: row.price_from, pt: row.price_to },
        })
      }

      if (dryRun) { updated++; continue }

      const { error } = await supabase.from(table).update(updates).eq('id', row.id)
      if (error) {
        summary.errors++
        console.log(`  ERR ${table} ${row.id}: ${error.message}`)
      } else {
        updated++
      }
    }
    return updated
  }

  summary.sd = await applyUpdates('scraper_dostartu', sdRows, r => String(r.source_id))
  summary.sa = await applyUpdates('scraper_all', saRows, r => {
    if (r.source === 'dostartu') return String(r.source_id)
    const link = (r.source_links || []).find(l => l.source === 'dostartu')
    return link ? String(link.source_id) : null
  })
  summary.ce = await applyUpdates('calendar_events', ceRows, r => String(r.source_id))

  if (ceLog.length > 0) {
    console.log(`\n--- calendar_events updates (${ceLog.length}) ---`)
    for (const e of ceLog) {
      const parts = []
      for (const [k, v] of Object.entries(e.updates)) {
        const old = k === 'registration_deadline' ? e.old.d : (k === 'price_from' ? e.old.pf : e.old.pt)
        parts.push(`${k}: ${old ?? 'null'} → ${v}`)
      }
      console.log(`  ${e.sid.padStart(6)}  ${e.name}`)
      for (const p of parts) console.log(`           ${p}`)
    }
  }

  console.log('\n--- Summary ---')
  console.log(`scraper_dostartu  updated: ${summary.sd}`)
  console.log(`scraper_all       updated: ${summary.sa}`)
  console.log(`calendar_events   updated: ${summary.ce}`)
  console.log(`API errors:                ${apiErrors.length}`)
  if (apiErrors.length > 0) {
    console.log(`  source_ids: ${apiErrors.slice(0, 20).map(e => e.sourceId).join(', ')}${apiErrors.length > 20 ? ' …' : ''}`)
  }
  if (dryRun) console.log('\n(DRY RUN — no changes written. Re-run with --apply.)')
}

main().catch(err => { console.error(err); process.exit(1) })
