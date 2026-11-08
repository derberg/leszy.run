import { createClient } from '@supabase/supabase-js'
import { writeRunLog } from './lib/run-log.js'
import { fetchRegister, parseRegister, registerRowKey, REGISTER_URL } from '../src/lib/atestRegister.js'
import { matchEvent, sameAtest } from '../src/lib/atestMatch.js'

// Usage: cd backend && node --env-file=../.env scripts/run-atest.js [--apply] [--offline]
//
// PZLA course certification (atest) for future races in scraper_all.
//   1. Reads the PZLA register of certified courses (REGISTER_URL) and upserts it
//      into atest_register. --offline, or a failed fetch, uses the stored copy:
//      the register changes a few times a month, a day-old copy is fine.
//   2. Matches every future scraper_all row to it, together with what the
//      regulamin said (scraper_all.atest_claim), and writes scraper_all.atest.
//      The rules are in src/lib/atestMatch.js: only a match the register backs
//      is written, everything weaker is printed as the review list below.
//   3. run-publish.js carries scraper_all.atest to calendar_events.atest.
//
// Dry run by default. --apply writes atest_register and scraper_all.atest, and
// a run log whose `changes` list (before and after of every row it changed) is
// what revert-atest.js --run-log undoes.

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const dryRun = !process.argv.includes('--apply')
const offline = process.argv.includes('--offline')
const startedAt = new Date().toISOString()
const PAGE = 1000

async function readAll(table, columns, build = (q) => q) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(supabase.from(table).select(columns)).range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}

async function loadRegister() {
  if (!offline) {
    try {
      const rows = parseRegister(await fetchRegister())
      // A page that parses to a handful of rows is a broken page, not a register.
      if (rows.length < 500) throw new Error(`only ${rows.length} rows parsed`)
      console.log(`[atest] register: ${rows.length} rows from ${REGISTER_URL}`)
      if (!dryRun) {
        const now = new Date().toISOString()
        const records = [...new Map(rows.map((r) => [registerRowKey(r), { row_key: registerRowKey(r), ...r, last_seen_at: now }])).values()]
        for (let i = 0; i < records.length; i += 500) {
          const { error } = await supabase.from('atest_register').upsert(records.slice(i, i + 500), { onConflict: 'row_key' })
          if (error) throw new Error(`atest_register upsert: ${error.message}`)
        }
      }
      return { rows, from: 'live' }
    } catch (err) {
      console.warn(`[atest] WARN: register fetch failed (${err.message}), using the stored copy`)
    }
  }
  // The stored copy: rows seen in the latest fetch only, so a row the register
  // dropped stops counting.
  const stored = await readAll('atest_register', 'distance_km, town, name, certified_on, status, last_seen_at')
  const latest = stored.reduce((m, r) => (r.last_seen_at > m ? r.last_seen_at : m), '')
  const day = latest.slice(0, 10)
  const rows = stored
    .filter((r) => r.last_seen_at.slice(0, 10) === day)
    .map((r) => ({ ...r, distance_km: Number(r.distance_km) }))
  console.log(`[atest] register: ${rows.length} stored rows (last fetched ${day || 'never'})`)
  return { rows, from: 'stored' }
}

async function main() {
  console.log(dryRun ? '[atest] DRY RUN — no writes. Use --apply.' : '[atest] --apply: writing atest_register and scraper_all.atest')
  const { rows: register, from } = await loadRegister()
  if (register.length === 0) {
    console.log('[atest] no register rows, nothing to match')
    return { exit: 0 }
  }

  const today = new Date().toISOString().slice(0, 10)
  const events = await readAll(
    'scraper_all',
    'id, name, date, location, distances, atest_claim, atest, source, source_id',
    (q) => q.gte('date', today).order('date'),
  )
  console.log(`[atest] ${events.length} future scraper_all rows`)

  let written = 0, cleared = 0, withAtest = 0
  const review = []
  const changes = []
  for (const ev of events) {
    const { atest, review: rev } = matchEvent(ev, register)
    if (atest.length) withAtest++
    for (const r of rev) review.push({ id: ev.id, name: ev.name, date: ev.date, location: ev.location, ...r })
    const next = atest.length ? atest : null
    if (sameAtest(ev.atest, next)) continue
    console.log(`  ${next ? '+' : '-'} [${ev.date}] ${ev.name} — ${next ? next.map((a) => `${a.km} km (${a.source})`).join(', ') : 'atest removed'}`)
    if (next) written++
    else cleared++
    if (!dryRun) {
      const { error } = await supabase.from('scraper_all').update({ atest: next }).eq('id', ev.id)
      if (error) console.log(`    ERR: ${error.message}`)
      else changes.push({ id: ev.id, name: ev.name, date: ev.date, source: ev.source, source_id: ev.source_id, before: ev.atest ?? null, after: next })
    }
  }

  const REASONS = {
    regulamin_denies: 'regulamin says NO atest, the register lists the course',
    claim_expired: 'regulamin claims an atest, the register row is expired or void',
    claim_unconfirmed: 'regulamin claims an atest, no register row matches',
    near_miss: 'register row in the same town and distance, name not certain',
  }
  if (review.length) {
    console.log(`\n[atest] Review — NOT written (${review.length})`)
    for (const reason of Object.keys(REASONS)) {
      const items = review.filter((r) => r.reason === reason)
      if (!items.length) continue
      console.log(`\n  ${reason}: ${REASONS[reason]}`)
      for (const r of items) {
        const reg = r.register_name ? ` ↔ ${r.register_name} (${r.register_town}, ${r.certified_on}${r.status ? `, ${r.status}` : ''}, score ${r.score})` : ''
        console.log(`    [${r.date}] ${r.name} — ${r.km ?? '?'} km${reg}`)
      }
    }
  }

  console.log(`\n[atest] register=${register.length} (${from}) events=${events.length} withAtest=${withAtest} ${dryRun ? 'wouldWrite' : 'written'}=${written} ${dryRun ? 'wouldClear' : 'cleared'}=${cleared} review=${review.length}`)
  if (!dryRun) {
    const file = await writeRunLog('atest', {
      script: 'atest', started_at: startedAt, ended_at: new Date().toISOString(),
      register_rows: register.length, register_from: from, events: events.length,
      with_atest: withAtest, written, cleared, changes, review,
    })
    console.log(`Run log: ${file}`)
  }
  return { exit: 0 }
}

main()
  .then(({ exit }) => process.exit(exit))
  .catch((err) => {
    console.error('[atest] CRASH:', err)
    process.exit(1)
  })
