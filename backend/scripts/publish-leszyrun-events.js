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

  // 3. Build manifest keyed by slug
  const manifest = {}
  for (const e of events || []) {
    const s = statsById[e.id] || {}
    manifest[e.slug] = {
      id: e.id,
      name: e.name,
      slug: e.slug,
      date: (e.date || '').slice(0, 10),
      location: e.location || null,
      stats: {
        participants: Number(s.participants || 0),
        finishers: Number(s.finishers || 0),
        distances: Array.isArray(s.distances) ? s.distances : [],
        fastest_ms: s.fastest_ms != null ? Number(s.fastest_ms) : null,
        fastest_name: s.fastest_name ? s.fastest_name.replace(/\s+/g, ' ').trim() : null,
      },
    }
  }

  const json = JSON.stringify(manifest, null, 2) + '\n'
  console.log(`Built manifest with ${Object.keys(manifest).length} past public event(s).`)
  for (const k of Object.keys(manifest)) {
    const m = manifest[k]
    console.log(`  ${k}: ${m.stats.participants} zapisanych, ${m.stats.finishers} na mecie, dyst. [${m.stats.distances.join(', ')}]`)
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
