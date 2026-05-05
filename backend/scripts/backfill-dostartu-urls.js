#!/usr/bin/env node

/**
 * Backfill registration_url + website for dostartu events on
 * scraper_dostartu, scraper_all, and calendar_events.
 *
 * Why this script exists:
 *   The old dostartu scraper preferred competition.websitePl over the
 *   dostartu permalink for `registration_url`. That put organizer info
 *   sites (e.g. biegherosa.pl) into the field that should have always
 *   been the dostartu permalink (the canonical registration target).
 *   The actual organizer website was never stored anywhere.
 *
 *   The scraper has now been corrected so:
 *     registration_url = makeUrl(permaLink, id)   (always dostartu)
 *     website          = competition.websitePl    (organizer site, may be null)
 *
 * What this backfill does:
 *   1. For each future dostartu event (default: status != 'rejected'),
 *      compute the correct registration_url + website from the API.
 *   2. Update scraper_dostartu (always — raw layer).
 *   3. Update scraper_all (always — merged layer).
 *   4. Update calendar_events:
 *        - registration_url: only if not currently a dostartu URL (so we
 *          don't fight admin-curated values that happen to be elsewhere)
 *          AND not in locked_fields.
 *        - website: only if currently null AND not in locked_fields
 *          (we don't want to erase admin-set websites).
 *
 * Usage:
 *   cd backend
 *   node --env-file=../.env scripts/backfill-dostartu-urls.js                     # dry-run
 *   node --env-file=../.env scripts/backfill-dostartu-urls.js --apply             # write
 *   node --env-file=../.env scripts/backfill-dostartu-urls.js --apply --pending-only
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
const RATE_LIMIT_MS = 350

const dryRun = !process.argv.includes('--apply')
const pendingOnly = process.argv.includes('--pending-only')
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function dostartuPermalink(permaLink, id) {
  if (permaLink) return `https://dostartu.pl${permaLink}`
  return `https://dostartu.pl/permalink-v${id}`
}

async function fetchCompetition(sourceId) {
  const res = await fetch(`${API_URL}/competitions/${sourceId}`, { headers: HEADERS })
  if (!res.ok) throw new Error(`competitions/${sourceId} → ${res.status}`)
  const j = await res.json()
  return j.competition || null
}

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

const isDostartuUrl = (u) => typeof u === 'string' && /^https?:\/\/(www\.)?dostartu\.pl\b/i.test(u)

async function main() {
  console.log(dryRun ? '=== DRY RUN (use --apply to write) ===\n' : '=== APPLYING UPDATES ===\n')
  if (pendingOnly) console.log('(--pending-only: calendar_events updates limited to status=pending)\n')

  const today = new Date().toISOString().split('T')[0]

  const sdRows = await fetchAllPaged(
    supabase.from('scraper_dostartu')
      .select('id, source_id, name, date, registration_url, website')
      .gte('date', today),
  )
  const saRows = await fetchAllPaged(
    supabase.from('scraper_all')
      .select('id, source, source_id, source_links, name, date, registration_url, website')
      .gte('date', today)
      .filter('source_links', 'cs', JSON.stringify([{ source: 'dostartu' }])),
  )

  let calQuery = supabase.from('calendar_events')
    .select('id, source, source_id, name, date, status, registration_url, website, locked_fields')
    .eq('source', 'dostartu')
    .gte('date', today)
    .neq('status', 'rejected')
  if (pendingOnly) calQuery = calQuery.eq('status', 'pending')
  const ceRows = await fetchAllPaged(calQuery)

  console.log(`scraper_dostartu (future):                       ${sdRows.length}`)
  console.log(`scraper_all (future, with dostartu source_link): ${saRows.length}`)
  console.log(`calendar_events (future, dostartu, !rejected${pendingOnly ? ', pending' : ''}):   ${ceRows.length}\n`)

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

  const fresh = new Map() // sourceId -> { registration_url, website }
  const apiErrors = []
  let i = 0
  for (const sid of sourceIds) {
    i++
    try {
      const c = await fetchCompetition(sid)
      if (c) {
        fresh.set(sid, {
          registration_url: dostartuPermalink(c.permaLink, c.id),
          website: c.websitePl || null,
        })
      }
    } catch (err) {
      apiErrors.push({ sourceId: sid, message: err.message })
    }
    if (i % 25 === 0 || i === sourceIds.size) console.log(`  fetched ${i}/${sourceIds.size}`)
    await sleep(RATE_LIMIT_MS)
  }

  // ---- scraper_dostartu: always overwrite both fields with API truth
  let sdUpdated = 0, sdErr = 0
  for (const row of sdRows) {
    const sid = String(row.source_id)
    const f = fresh.get(sid)
    if (!f) continue
    const updates = {}
    if (row.registration_url !== f.registration_url) updates.registration_url = f.registration_url
    if ((row.website || null) !== (f.website || null)) updates.website = f.website
    if (Object.keys(updates).length === 0) continue
    if (dryRun) { sdUpdated++; continue }
    const { error } = await supabase.from('scraper_dostartu').update(updates).eq('id', row.id)
    if (error) { sdErr++; console.log(`  ERR sd ${row.id}: ${error.message}`) }
    else sdUpdated++
  }

  // ---- scraper_all: always overwrite both fields when this row's primary source is dostartu;
  //      otherwise only fill empties (so a higher-priority source's URLs aren't clobbered)
  let saUpdated = 0, saErr = 0
  for (const row of saRows) {
    let sid = null
    let isPrimary = false
    if (row.source === 'dostartu') { sid = String(row.source_id); isPrimary = true }
    else {
      const link = (row.source_links || []).find(l => l.source === 'dostartu')
      sid = link ? String(link.source_id) : null
    }
    if (!sid) continue
    const f = fresh.get(sid)
    if (!f) continue

    const updates = {}
    if (isPrimary) {
      if (row.registration_url !== f.registration_url) updates.registration_url = f.registration_url
      if ((row.website || null) !== (f.website || null)) updates.website = f.website
    } else {
      if (!row.registration_url) updates.registration_url = f.registration_url
      if (!row.website && f.website) updates.website = f.website
    }
    if (Object.keys(updates).length === 0) continue
    if (dryRun) { saUpdated++; continue }
    const { error } = await supabase.from('scraper_all').update(updates).eq('id', row.id)
    if (error) { saErr++; console.log(`  ERR sa ${row.id}: ${error.message}`) }
    else saUpdated++
  }

  // ---- calendar_events: cautious
  //      registration_url: replace only if currently NOT a dostartu URL AND not locked
  //      website:          fill only if currently empty AND not locked
  const ceLog = []
  let ceUpdated = 0, ceSkippedLocked = 0, ceErr = 0
  for (const row of ceRows) {
    const sid = String(row.source_id)
    const f = fresh.get(sid)
    if (!f) continue

    const locked = new Set(Array.isArray(row.locked_fields) ? row.locked_fields : [])
    const updates = {}

    // registration_url
    if (!locked.has('registration_url') && row.registration_url !== f.registration_url) {
      // Replace only if the existing URL is NOT already a dostartu permalink for this event.
      if (!isDostartuUrl(row.registration_url)) {
        updates.registration_url = f.registration_url
      }
    }
    if (locked.has('registration_url') && !isDostartuUrl(row.registration_url)) {
      ceSkippedLocked++
    }

    // website (organizer external site) — only fill empty
    if (!locked.has('website') && !row.website && f.website) {
      updates.website = f.website
    }

    if (Object.keys(updates).length === 0) continue

    ceLog.push({ sid, name: row.name, status: row.status, old: { reg: row.registration_url, web: row.website }, updates })
    if (dryRun) { ceUpdated++; continue }
    const { error } = await supabase.from('calendar_events').update(updates).eq('id', row.id)
    if (error) { ceErr++; console.log(`  ERR ce ${row.id}: ${error.message}`) }
    else ceUpdated++
  }

  if (ceLog.length > 0) {
    console.log(`\n--- calendar_events updates (${ceLog.length}) ---`)
    const truncate = (s, n = 70) => s && s.length > n ? s.slice(0, n - 1) + '…' : s
    for (const e of ceLog) {
      console.log(`  ${e.sid.padStart(6)}  [${e.status}]  ${e.name}`)
      if ('registration_url' in e.updates) {
        console.log(`           reg:    ${truncate(e.old.reg) || '(null)'}`)
        console.log(`             →    ${truncate(e.updates.registration_url)}`)
      }
      if ('website' in e.updates) {
        console.log(`           web:    ${truncate(e.old.web) || '(null)'}`)
        console.log(`             →    ${truncate(e.updates.website) || '(null)'}`)
      }
    }
  }

  console.log('\n--- Summary ---')
  console.log(`scraper_dostartu  updated: ${sdUpdated}  errors: ${sdErr}`)
  console.log(`scraper_all       updated: ${saUpdated}  errors: ${saErr}`)
  console.log(`calendar_events   updated: ${ceUpdated}  errors: ${ceErr}  skipped(locked): ${ceSkippedLocked}`)
  console.log(`API errors: ${apiErrors.length}`)
  if (apiErrors.length > 0) {
    console.log(`  source_ids: ${apiErrors.slice(0, 30).map(e => e.sourceId).join(', ')}${apiErrors.length > 30 ? ' …' : ''}`)
  }
  if (dryRun) console.log('\n(DRY RUN — no changes written. Re-run with --apply.)')
}

main().catch(err => { console.error(err); process.exit(1) })
