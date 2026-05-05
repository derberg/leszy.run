#!/usr/bin/env node

/**
 * Backfill registration_url for datasport events on
 * scraper_datasport, scraper_all, and calendar_events.
 *
 * Background:
 *   The datasport scraper used to hardcode registration_url=null. The
 *   datasport site exposes a stable registration URL pattern keyed by
 *   competition id ("zawody"):
 *     https://online.datasport.pl/zapisy/portal/baza/wizardnew/?zawody=<id>
 *   so we can construct it from source_id alone — no extra HTTP calls.
 *
 * Usage:
 *   cd backend
 *   node --env-file=../.env scripts/backfill-datasport-registration-url.js          # dry-run
 *   node --env-file=../.env scripts/backfill-datasport-registration-url.js --apply  # write
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const dryRun = !process.argv.includes('--apply')
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const buildUrl = (sourceId) =>
  `https://online.datasport.pl/zapisy/portal/baza/wizardnew/?zawody=${sourceId}`

async function fetchAllPaged(query) {
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

async function main() {
  console.log(dryRun ? '=== DRY RUN (use --apply to write) ===\n' : '=== APPLYING UPDATES ===\n')

  const today = new Date().toISOString().split('T')[0]

  const sdRows = await fetchAllPaged(
    supabase.from('scraper_datasport')
      .select('id, source_id, name, date, registration_url')
      .gte('date', today),
  )
  const saRows = await fetchAllPaged(
    supabase.from('scraper_all')
      .select('id, source, source_id, source_links, name, date, registration_url')
      .gte('date', today)
      .filter('source_links', 'cs', JSON.stringify([{ source: 'datasport' }])),
  )
  const ceRows = await fetchAllPaged(
    supabase.from('calendar_events')
      .select('id, source, source_id, name, date, status, registration_url, locked_fields')
      .eq('source', 'datasport')
      .gte('date', today)
      .neq('status', 'rejected'),
  )

  console.log(`scraper_datasport (future):                    ${sdRows.length}`)
  console.log(`scraper_all (future, datasport in source_links): ${saRows.length}`)
  console.log(`calendar_events (future, datasport, !rejected):  ${ceRows.length}\n`)

  // scraper_datasport: fill empty registration_url
  let sdUpdated = 0, sdErr = 0
  for (const row of sdRows) {
    const target = buildUrl(row.source_id)
    if (row.registration_url === target) continue
    if (dryRun) { sdUpdated++; continue }
    const { error } = await supabase.from('scraper_datasport').update({ registration_url: target }).eq('id', row.id)
    if (error) { sdErr++; console.log(`  ERR sd ${row.id}: ${error.message}`) }
    else sdUpdated++
  }

  // scraper_all: only fill empties for datasport-primary rows or rows where datasport is in source_links and registration_url is null
  let saUpdated = 0, saErr = 0
  for (const row of saRows) {
    let dsId = null
    if (row.source === 'datasport') dsId = row.source_id
    else {
      const link = (row.source_links || []).find(l => l.source === 'datasport')
      dsId = link?.source_id || null
    }
    if (!dsId) continue
    const target = buildUrl(dsId)
    if (row.registration_url) continue  // never clobber existing URL — could be from a higher-priority source
    if (dryRun) { saUpdated++; continue }
    const { error } = await supabase.from('scraper_all').update({ registration_url: target }).eq('id', row.id)
    if (error) { saErr++; console.log(`  ERR sa ${row.id}: ${error.message}`) }
    else saUpdated++
  }

  // calendar_events: respect locked_fields, only fill empties
  const ceLog = []
  let ceUpdated = 0, ceErr = 0
  for (const row of ceRows) {
    if (row.registration_url) continue
    const locked = new Set(Array.isArray(row.locked_fields) ? row.locked_fields : [])
    if (locked.has('registration_url')) continue
    const target = buildUrl(row.source_id)
    ceLog.push({ name: row.name, status: row.status, source_id: row.source_id, target })
    if (dryRun) { ceUpdated++; continue }
    const { error } = await supabase.from('calendar_events').update({ registration_url: target }).eq('id', row.id)
    if (error) { ceErr++; console.log(`  ERR ce ${row.id}: ${error.message}`) }
    else ceUpdated++
  }

  if (ceLog.length > 0) {
    console.log(`\n--- calendar_events updates (${ceLog.length}) ---`)
    for (const e of ceLog) {
      console.log(`  [${e.status}]  ${e.source_id.padStart(6)}  ${e.name}`)
    }
  }

  console.log('\n--- Summary ---')
  console.log(`scraper_datasport  updated: ${sdUpdated}  errors: ${sdErr}`)
  console.log(`scraper_all        updated: ${saUpdated}  errors: ${saErr}`)
  console.log(`calendar_events    updated: ${ceUpdated}  errors: ${ceErr}`)
  if (dryRun) console.log('\n(DRY RUN — no changes written. Re-run with --apply.)')
}

main().catch(err => { console.error(err); process.exit(1) })
