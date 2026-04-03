// Usage: cd backend && node --env-file=../.env scripts/publish-event-pages.js [--apply]
// Generates static event pages manifest + OG images for the public kalendarz.
// Dry run by default — use --apply to write files.

import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { generateEventOg } from '../../public/scripts/generate-event-og.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..')
const KALENDARZ_DIR = resolve(PROJECT_ROOT, 'public/public/kalendarz')
const MANIFEST_PATH = resolve(KALENDARZ_DIR, '.manifest.json')

// --- Slugify (duplicated from public/src/lib/slugify.js for Node compat) ---

const POLISH_MAP = {
  'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n',
  'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
  'Ą': 'a', 'Ć': 'c', 'Ę': 'e', 'Ł': 'l', 'Ń': 'n',
  'Ó': 'o', 'Ś': 's', 'Ź': 'z', 'Ż': 'z',
}

function slugify(name, date, id) {
  const base = name
    .toLowerCase()
    .replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, ch => POLISH_MAP[ch] || ch)
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  const dateStr = date.slice(0, 10)
  const slug = `${base}-${dateStr}`

  return id ? `${slug}-${id.slice(0, 4)}` : slug
}

// --- Main ---

const dryRun = !process.argv.includes('--apply')

async function main() {
  if (dryRun) console.log('=== DRY RUN (use --apply to write files) ===\n')

  // 1. Create Supabase client
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/VITE_SUPABASE_ANON_KEY')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  // 2. Load existing manifest
  let oldManifest = {}
  if (existsSync(MANIFEST_PATH)) {
    try {
      oldManifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
    } catch (err) {
      console.warn('Warning: could not parse existing manifest, starting fresh')
      oldManifest = {}
    }
  }

  // 3. Query active calendar events
  const { data: events, error } = await supabase
    .from('calendar_events')
    .select('*')
    .eq('status', 'active')
    .order('date', { ascending: true })

  if (error) {
    console.error('Supabase query error:', error.message)
    process.exit(1)
  }

  if (!events || events.length === 0) {
    console.log('No active calendar events found.')
    if (!dryRun) {
      // Write empty manifest, clean up removed dirs
      const removedSlugs = Object.keys(oldManifest)
      for (const slug of removedSlugs) {
        const dir = resolve(KALENDARZ_DIR, slug)
        if (existsSync(dir)) rmSync(dir, { recursive: true })
      }
      mkdirSync(KALENDARZ_DIR, { recursive: true })
      writeFileSync(MANIFEST_PATH, JSON.stringify({}, null, 2))
      console.log(`Removed ${removedSlugs.length} old event directories.`)
    }
    return
  }

  console.log(`Found ${events.length} active events.\n`)

  // 4-5. Build slugs, handle duplicates
  const slugCounts = new Map()
  const eventSlugs = []

  for (const event of events) {
    if (!event.name || !event.date) {
      console.warn(`  Skipping event ${event.id} — missing name or date`)
      continue
    }

    let slug = slugify(event.name, event.date)

    // Track slug occurrences for dedup
    const count = slugCounts.get(slug) || 0
    slugCounts.set(slug, count + 1)

    if (count > 0) {
      // Duplicate slug — append first 4 chars of ID
      slug = slugify(event.name, event.date, event.id)
    }

    eventSlugs.push({ event, slug })
  }

  // Second pass: if any slug had duplicates, the FIRST occurrence also needs dedup
  const dupeBaseSlugs = new Set()
  for (const [baseSlug, count] of slugCounts) {
    if (count > 1) dupeBaseSlugs.add(baseSlug)
  }

  for (const entry of eventSlugs) {
    const baseSlug = slugify(entry.event.name, entry.event.date)
    if (dupeBaseSlugs.has(baseSlug) && entry.slug === baseSlug) {
      // First occurrence of a duplicate — also needs ID suffix
      entry.slug = slugify(entry.event.name, entry.event.date, entry.event.id)
    }
  }

  // 6. Build new manifest
  const newManifest = {}
  for (const { event, slug } of eventSlugs) {
    newManifest[slug] = {
      id: event.id,
      name: event.name,
      date: event.date,
      end_date: event.end_date || null,
      location: event.location || null,
      voivodeship: event.voivodeship || null,
      lat: event.lat || null,
      lng: event.lng || null,
      distances: event.distances || null,
      event_type: event.event_type || null,
      registration_url: event.registration_url || null,
      website: event.website || null,
      regulamin_url: event.regulamin_url || null,
      price_from: event.price_from ?? null,
      price_to: event.price_to ?? null,
      registration_deadline: event.registration_deadline || null,
      max_participants: event.max_participants ?? null,
      elevation_gain_m: event.elevation_gain_m ?? null,
      surface: event.surface || null,
      is_night: event.is_night ?? null,
      is_charity: event.is_charity ?? null,
      is_kids: event.is_kids ?? null,
    }
  }

  // 7. Diff
  const oldSlugs = new Set(Object.keys(oldManifest))
  const newSlugs = new Set(Object.keys(newManifest))

  const added = []
  const changed = []
  const removed = []

  for (const slug of newSlugs) {
    if (!oldSlugs.has(slug)) {
      added.push(slug)
    } else if (JSON.stringify(oldManifest[slug]) !== JSON.stringify(newManifest[slug])) {
      changed.push(slug)
    }
  }

  for (const slug of oldSlugs) {
    if (!newSlugs.has(slug)) {
      removed.push(slug)
    }
  }

  const unchanged = newSlugs.size - added.length - changed.length

  console.log('--- Manifest Diff ---')
  console.log(`  Total events: ${newSlugs.size}`)
  console.log(`  Added:     ${added.length}`)
  console.log(`  Changed:   ${changed.length}`)
  console.log(`  Removed:   ${removed.length}`)
  console.log(`  Unchanged: ${unchanged}`)

  if (added.length > 0) {
    console.log('\n  New events:')
    for (const s of added.slice(0, 20)) console.log(`    + ${s}`)
    if (added.length > 20) console.log(`    ... and ${added.length - 20} more`)
  }

  if (removed.length > 0) {
    console.log('\n  Removed events:')
    for (const s of removed.slice(0, 20)) console.log(`    - ${s}`)
    if (removed.length > 20) console.log(`    ... and ${removed.length - 20} more`)
  }

  // 8. Dry run — stop here
  if (dryRun) {
    console.log('\nDry run complete. Use --apply to write files.')
    return
  }

  // 9. Apply changes
  console.log('\nApplying changes...')
  mkdirSync(KALENDARZ_DIR, { recursive: true })

  // Generate OG images for new/changed events
  const toGenerate = [...added, ...changed]
  let generated = 0
  let genErrors = 0

  for (const slug of toGenerate) {
    const eventDir = resolve(KALENDARZ_DIR, slug)
    mkdirSync(eventDir, { recursive: true })

    const ogPath = resolve(eventDir, 'og.png')
    try {
      await generateEventOg(newManifest[slug], ogPath)
      generated++
      if (generated % 50 === 0) {
        console.log(`  Generated ${generated}/${toGenerate.length} OG images...`)
      }
    } catch (err) {
      genErrors++
      console.error(`  Error generating OG for ${slug}: ${err.message}`)
    }
  }

  // Remove directories for removed events
  for (const slug of removed) {
    const eventDir = resolve(KALENDARZ_DIR, slug)
    if (existsSync(eventDir)) {
      rmSync(eventDir, { recursive: true })
    }
  }

  // Write manifest
  writeFileSync(MANIFEST_PATH, JSON.stringify(newManifest, null, 2))

  console.log('\n--- Apply Summary ---')
  console.log(`  OG images generated: ${generated}`)
  console.log(`  OG image errors:     ${genErrors}`)
  console.log(`  Directories removed: ${removed.length}`)
  console.log(`  Manifest written:    ${MANIFEST_PATH}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
