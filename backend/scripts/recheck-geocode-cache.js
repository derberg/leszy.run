// Re-asks Nominatim for every name in geocode_cache and reports the cached
// answers the geocoder would no longer give.
//
// geocode() returns a cache hit before its checks run, so an entry written
// before the geocoder refused ambiguous names keeps answering for every place
// of that name. "Chwałowice" (villages in six voivodeships) was cached on
// 2026-03-23 as the Świętokrzyskie one, and the four Chwałowicki Maraton
// Napoleoński editions near Jelcz-Laskowice (Dolnośląskie) published with it.
// The wrong region then made the enricher's verifier reject pages that named
// the right one.
//
// Usage (from backend/):
//   node --env-file=../.env scripts/recheck-geocode-cache.js            # dry run, report only
//   node --env-file=../.env scripts/recheck-geocode-cache.js --apply    # delete flagged cache rows
//   --limit <n>      check only the first n cache rows
//   --name <query>   check one location_query
//   --from-log <f>   check only the names flagged in an earlier run's log
//
// Nominatim allows one request a second, so the full cache takes about half an
// hour. Statuses:
//   ambiguous   settlements of that name in more than one voivodeship
//   moved       one answer today, in a different voivodeship than cached
//   unresolved  no answer today (kept: a flaky search is no evidence)
//   ok          the cached voivodeship is still the answer
//
// --apply deletes only `ambiguous` and `moved` rows from geocode_cache. The
// next run-geocode refuses an ambiguous name and re-caches a moved one. It
// does not touch scraper_all or calendar_events: the report lists the future
// rows that carry a flagged name with the cached voivodeship, for a person to
// review, because a scraper may have published that voivodeship itself.
// Each listed row says what the geocoder answers today (`proposed`): a
// voivodeship and coordinates, or null when the name is ambiguous and only a
// person can tell which village the race is in. A row whose raw scraper table
// carries the same voivodeship got it from its source, not from the cache, and
// is marked `fromSource`.

import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { nominatimAnswer, parseCacheKey, searchNominatim, capitalizeVoivodeship } from '../src/scrapers/geocoder.js'

export function classifyCacheRow(row, nominatimHits) {
  const answer = nominatimAnswer(nominatimHits, row.location_query)
  const cachedVoiv = capitalizeVoivodeship(row.voivodeship) || null
  if (answer.ambiguous) return { status: 'ambiguous', cached: cachedVoiv, now: answer.states, proposed: null }
  const state = answer.chosen?.address?.state || answer.chosen?.address?.province
  const nowVoiv = capitalizeVoivodeship(state) || null
  if (!answer.chosen || !nowVoiv) return { status: 'unresolved', cached: cachedVoiv, now: [], proposed: null }
  const proposed = { voivodeship: nowVoiv, lat: parseFloat(answer.chosen.lat), lng: parseFloat(answer.chosen.lon) }
  if (cachedVoiv && nowVoiv !== cachedVoiv) return { status: 'moved', cached: cachedVoiv, now: [nowVoiv], proposed }
  return { status: 'ok', cached: cachedVoiv, now: [nowVoiv], proposed }
}

async function fetchAll(supabase, table, columns, build = q => q) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(supabase.from(table).select(columns)).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...data)
    if (data.length < 1000) return rows
  }
}

async function main() {
  const { supabase } = await import('../src/lib/supabaseClient.js')
  if (!supabase) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(1) }
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : null
  const name = args.includes('--name') ? args[args.indexOf('--name') + 1] : null
  const fromLog = args.includes('--from-log') ? args[args.indexOf('--from-log') + 1] : null
  const onlyNames = fromLog
    ? new Set(JSON.parse(readFileSync(fromLog, 'utf8')).flagged.map(f => f.location_query))
    : null

  let cache = await fetchAll(supabase, 'geocode_cache', 'id, location_query, voivodeship, lat, lng, created_at',
    q => (name ? q.eq('location_query', name) : q).order('created_at'))
  if (onlyNames) cache = cache.filter(r => onlyNames.has(r.location_query))
  if (limit) cache = cache.slice(0, limit)
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: checking ${cache.length} cached names (~${Math.ceil(cache.length * 1.1 / 60)} min)`)

  const flagged = []
  const counts = { ok: 0, ambiguous: 0, moved: 0, unresolved: 0, failed: 0 }
  for (const [i, row] of cache.entries()) {
    try {
      const hits = await searchNominatim(row.location_query, parseCacheKey(row.location_query))
      const verdict = classifyCacheRow(row, hits)
      counts[verdict.status]++
      if (verdict.status === 'ambiguous' || verdict.status === 'moved') {
        flagged.push({ ...row, ...verdict })
        console.log(`  ${verdict.status.padEnd(9)} ${row.location_query}: cached ${verdict.cached}, now ${verdict.now.join(' / ')}`)
      }
    } catch (err) {
      counts.failed++
      console.error(`  failed    ${row.location_query}: ${err.message}`)
    }
    if ((i + 1) % 100 === 0) console.log(`  … ${i + 1}/${cache.length}`)
  }

  // Future rows that carry a flagged name with the cached voivodeship.
  const today = new Date().toISOString().slice(0, 10)
  const byName = new Map(flagged.map(f => [f.location_query.toLowerCase(), f]))
  const affected = []
  for (const table of ['scraper_all', 'calendar_events']) {
    const rows = await fetchAll(supabase, table, 'id, name, date, location, voivodeship, source, source_id',
      q => q.gte('date', today))
    for (const r of rows) {
      const f = byName.get(String(r.location || '').trim().toLowerCase())
      if (f && capitalizeVoivodeship(r.voivodeship) === f.cached) affected.push({ table, ...r, flag: f.status, proposed: f.proposed })
    }
  }
  const rawVoiv = new Map()
  for (const src of new Set(affected.map(a => a.source))) {
    const ids = [...new Set(affected.filter(a => a.source === src).map(a => a.source_id))]
    const { data, error } = await supabase.from(`scraper_${src}`).select('source_id, voivodeship').in('source_id', ids)
    if (error) continue
    for (const d of data) if (d.voivodeship) rawVoiv.set(`${src}:${d.source_id}`, capitalizeVoivodeship(d.voivodeship))
  }
  for (const a of affected) a.fromSource = rawVoiv.get(`${a.source}:${a.source_id}`) === capitalizeVoivodeship(a.voivodeship)

  console.log(`\nok ${counts.ok}, ambiguous ${counts.ambiguous}, moved ${counts.moved}, unresolved ${counts.unresolved}, failed ${counts.failed}`)
  console.log(`future rows carrying a flagged name with its cached voivodeship: ${affected.length}`)
  for (const a of affected) {
    const to = a.proposed ? `→ ${a.proposed.voivodeship}` : '→ ?'
    console.log(`  ${a.table} ${a.date} ${a.name} — ${a.location}, ${a.voivodeship} ${to}${a.fromSource ? ' (from source)' : ''} [${a.source}:${a.source_id}]`)
  }

  mkdirSync('logs', { recursive: true })
  const logPath = `logs/geocode-recheck-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(logPath, JSON.stringify({ apply, counts, flagged, affected }, null, 2))
  console.log(`log: ${logPath}`)

  if (apply && flagged.length) {
    const ids = flagged.map(f => f.id)
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await supabase.from('geocode_cache').delete().in('id', ids.slice(i, i + 200))
      if (error) { console.error(`delete failed: ${error.message}`); process.exit(1) }
    }
    console.log(`deleted ${ids.length} geocode_cache rows`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1) })
}
