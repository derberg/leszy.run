// Usage: cd backend && node --env-file=../.env scripts/publish-leszyrun-events.js [--apply]
// Reads the event_results_summary view + events table and writes a committed manifest of
// PAST, PUBLIC leszy.run events with baked stats, consumed by
// public/scripts/generate-leszyrun-event-pages.js at build time.
// Dry run by default — use --apply to write the manifest.

import { createClient } from '@supabase/supabase-js'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..')
const EVENTS_DIR = resolve(PROJECT_ROOT, 'public/public/events')
const MANIFEST_PATH = resolve(EVENTS_DIR, '.manifest.json')

const dryRun = !process.argv.includes('--apply')

async function main() {
  if (dryRun) console.log('=== DRY RUN (use --apply to write the manifest) ===\n')

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/VITE_SUPABASE_ANON_KEY')
    process.exit(1)
  }
  const supabase = createClient(supabaseUrl, supabaseKey)

  const today = new Date().toISOString().slice(0, 10)

  // 1. Past public events
  const { data: events, error: evErr } = await supabase
    .from('events')
    .select('id, name, slug, date, location, visibility')
    .eq('visibility', 'public')
    .lt('date', today)
    .order('date', { ascending: false })
  if (evErr) { console.error('events fetch error:', evErr.message); process.exit(1) }

  if (!events || events.length === 0) {
    console.log('No past public events found. Writing empty manifest.')
  }

  // 2. Stats for those events
  const ids = (events || []).map(e => e.id)
  let statsById = {}
  if (ids.length > 0) {
    const { data: stats, error: stErr } = await supabase
      .from('event_results_summary')
      .select('event_id, participants, finishers, distances, fastest_ms, fastest_name')
      .in('event_id', ids)
    if (stErr) { console.error('summary fetch error:', stErr.message); process.exit(1) }
    statsById = Object.fromEntries((stats || []).map(s => [s.event_id, s]))
  }

  // 2b. Per-category / per-gender best times
  const bestByEvent = {}
  if (ids.length > 0) {
    const { data: cbt, error: cbtErr } = await supabase
      .from('event_category_best_times')
      .select('event_id, category, gender, best_ms')
      .in('event_id', ids)
    if (cbtErr) { console.error('category best times fetch error:', cbtErr.message); process.exit(1) }
    for (const row of cbt || []) {
      const ev = bestByEvent[row.event_id] || (bestByEvent[row.event_id] = {})
      const cat = ev[row.category] || (ev[row.category] = { category: row.category, k_ms: null, m_ms: null })
      const ms = row.best_ms != null ? Number(row.best_ms) : null
      if (row.gender === 'K') cat.k_ms = ms
      else if (row.gender === 'M') cat.m_ms = ms
    }
  }

  // 2c. Full final results per event — baked so the build can pre-render a static
  // /events/:slug/results page (SEO: the SPA route is invisible to crawlers).
  // Uses participants_public (same masked view the public Results SPA reads).
  const resultsByEvent = {}
  for (const eventId of ids) {
    const { data: cats, error: catErr } = await supabase
      .from('categories')
      .select('id, name, untimed')
      .eq('event_id', eventId)
    if (catErr) { console.error('categories fetch error:', catErr.message); process.exit(1) }
    const timedCats = (cats || []).filter(c => !c.untimed)
    const eventResults = []
    for (const cat of timedCats) {
      const { data: runs, error: runErr } = await supabase
        .from('race_runs')
        .select('id, started_at, status')
        .eq('category_id', cat.id)
        .eq('status', 'finished')
        .order('created_at', { ascending: false })
        .limit(1)
      if (runErr) { console.error('race_runs fetch error:', runErr.message); process.exit(1) }
      const run = runs && runs[0]
      if (!run) continue

      // Page past PostgREST's 1000-row cap
      const rows = []
      for (let from = 0; ; from += 1000) {
        const { data: page, error: resErr } = await supabase
          .from('results')
          .select('participant_id, start_time, finish_time, duration_ms, gun_duration_ms, status')
          .eq('race_run_id', run.id)
          .range(from, from + 999)
        if (resErr) { console.error('results fetch error:', resErr.message); process.exit(1) }
        rows.push(...(page || []))
        if (!page || page.length < 1000) break
      }
      if (rows.length === 0) continue

      const { data: parts, error: pErr } = await supabase
        .from('participants_public')
        .select('id, bib_number, first_name, last_name, club, gender, deleted_at')
        .eq('category_id', cat.id)
      if (pErr) { console.error('participants fetch error:', pErr.message); process.exit(1) }
      const partById = Object.fromEntries((parts || []).map(p => [p.id, p]))

      eventResults.push({
        category: cat.name,
        startedAt: run.started_at || null,
        // Deleted accounts stay in the archive but anonymized — same policy as the
        // SPA's anonymizedName() helper (name + club masked, result kept).
        rows: rows
          .filter(r => partById[r.participant_id])
          .map(r => {
            const p = partById[r.participant_id]
            const deleted = Boolean(p.deleted_at)
            return {
              participantId: r.participant_id,
              bib: p.bib_number ?? null,
              firstName: deleted ? null : (p.first_name || ''),
              lastName: deleted ? null : (p.last_name || ''),
              club: deleted ? null : (p.club || null),
              gender: p.gender || null,
              deleted,
              startTime: r.start_time || null,
              finishTime: r.finish_time || null,
              durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
              gunDurationMs: r.gun_duration_ms != null ? Number(r.gun_duration_ms) : null,
              status: r.status || null,
            }
          }),
      })
    }
    eventResults.sort((a, b) => a.category.localeCompare(b.category, 'pl'))
    if (eventResults.length > 0) resultsByEvent[eventId] = eventResults
  }

  // 3. Build manifest keyed by slug
  const manifest = {}
  for (const e of events || []) {
    const s = statsById[e.id] || {}
    const bestMap = bestByEvent[e.id] || {}
    const bestTimes = Object.values(bestMap)
      .sort((a, b) => a.category.localeCompare(b.category, 'pl'))
    manifest[e.slug] = {
      id: e.id,
      name: e.name,
      slug: e.slug,
      date: (e.date || '').slice(0, 10),
      location: e.location || null,
      stats: {
        participants: Number(s.participants || 0),
        distances: Array.isArray(s.distances) ? s.distances : [],
        bestTimes,
      },
      results: resultsByEvent[e.id] || [],
    }
  }

  const json = JSON.stringify(manifest, null, 2) + '\n'
  console.log(`Built manifest with ${Object.keys(manifest).length} past public event(s).`)
  for (const k of Object.keys(manifest)) {
    const m = manifest[k]
    const resultRows = m.results.reduce((n, c) => n + c.rows.length, 0)
    console.log(`  ${k}: ${m.stats.participants} zapisanych, ${m.stats.bestTimes.length} kategorii z czasami, ${resultRows} wierszy wyników w ${m.results.length} kategoriach`)
  }

  if (dryRun) {
    console.log(`\n(dry run) Would write ${MANIFEST_PATH}`)
    return
  }
  mkdirSync(EVENTS_DIR, { recursive: true })
  writeFileSync(MANIFEST_PATH, json)
  console.log(`\nWrote ${MANIFEST_PATH}`)
}

main()
