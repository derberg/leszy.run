// Usage: cd backend && node --env-file=../.env scripts/publish-event-pages.js [--apply] [--regen-og]
// Publishes the kalendarz manifest + OG images for the public kalendarz to
// Supabase Storage (manifest: private bucket calendar-manifests/kalendarz.json;
// images: public bucket calendar-og/kalendarz/<slug>/og.png). Neither is in git.
// Dry run by default — use --apply to upload. --apply also stamps
// public/data-version.json; commit that file to deploy the site.
// --regen-og: regenerate ALL OG images (use after changing the OG template)

import { createClient } from '@supabase/supabase-js'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { renderEventOg } from '../../public/scripts/generate-event-og.js'
import { writeRunLog } from './lib/run-log.js'
import { buildManifestEntry, shareImageView } from './lib/manifestEntry.js'
import { stampPublish, ogSlugsToGenerate } from './lib/publishHelpers.js'
import { carryFormerSlugs } from '../../public/scripts/lib/formerSlugs.js'
import {
  storageConfig, readManifest, writeManifest, listOgSlugs, uploadOg, removeOgs, mapLimit,
  MANIFEST_BUCKET, OG_BUCKET,
} from '../../public/scripts/lib/publicData.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..')
const OG_CONCURRENCY = 6

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
  const startedAt = new Date().toISOString()
  if (dryRun) console.log('=== DRY RUN (use --apply to write files) ===\n')

  // 1. Create Supabase client. The service role key is required even for a dry
  // run: the published manifest lives in a private bucket.
  let cfg
  try {
    cfg = storageConfig()
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }

  const supabase = createClient(cfg.url, cfg.key)

  // 2. Load the published manifest from Storage. It keeps the diff below
  // honest: only events whose share image changed get a new image.
  let oldManifest = await readManifest(cfg, 'kalendarz')
  if (oldManifest === null) {
    console.warn(`Warning: no kalendarz.json in bucket ${MANIFEST_BUCKET} yet — every event counts as new.`)
    oldManifest = {}
  }

  // 3. Query active calendar events
  // Note: Supabase's PostgREST gateway caps each response at 1000 rows,
  // so paginate with .range() until we've read everything.
  const PAGE_SIZE = 1000
  const events = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from('calendar_events')
      .select('*')
      .in('status', ['active', 'cancelled'])
      .order('date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)

    if (error) {
      console.error('Supabase query error:', error.message)
      process.exit(1)
    }

    if (!page || page.length === 0) break
    events.push(...page)
    if (page.length < PAGE_SIZE) break
  }

  if (!events || events.length === 0) {
    // An empty calendar is never published: the build refuses an empty
    // kalendarz manifest, and a query that silently returned nothing must not
    // delete every OG image.
    console.error('No active calendar events found. Refusing to publish an empty kalendarz manifest.')
    process.exit(1)
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
    newManifest[slug] = buildManifestEntry(event)
  }
  // Every address an event had before stays as a redirect stub
  // (generate-event-pages.js): the slug carries the date, and run-publish moves
  // a race's date when its source moved it.
  const readdressed = carryFormerSlugs(oldManifest, newManifest)

  // 7. Diff
  const oldSlugs = new Set(Object.keys(oldManifest))
  const newSlugs = new Set(Object.keys(newManifest))

  const added = []
  const changed = []
  const removed = []

  for (const slug of newSlugs) {
    if (!oldSlugs.has(slug)) {
      added.push(slug)
    } else if (JSON.stringify(shareImageView(oldManifest[slug])) !== JSON.stringify(shareImageView(newManifest[slug]))) {
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

  if (readdressed.length > 0) {
    console.log(`\n  New addresses (${readdressed.length}; the old one redirects):`)
    for (const r of readdressed.slice(0, 50)) console.log(`    ${r.from} → ${r.to}`)
    if (readdressed.length > 50) console.log(`    ... and ${readdressed.length - 50} more`)
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

  // Generate OG images for new/changed events + any image missing from the bucket
  const regenOg = process.argv.includes('--regen-og')
  const existingOg = await listOgSlugs(cfg)
  const toGenerate = ogSlugsToGenerate({ newSlugs: [...newSlugs], added, changed, existingOg, regenOg })
  if (regenOg) {
    console.log(`  --regen-og: regenerating ALL ${toGenerate.length} OG images`)
  } else {
    const missing = toGenerate.length - added.length - changed.length
    if (missing) console.log(`  ${missing} unchanged events missing OG images in ${OG_BUCKET}`)
  }
  let generated = 0
  let genErrors = 0
  const ogErrors = []

  await mapLimit(toGenerate, OG_CONCURRENCY, async slug => {
    try {
      const png = await renderEventOg(newManifest[slug])
      await uploadOg(cfg, slug, png)
      generated++
      if (generated % 50 === 0) {
        console.log(`  Uploaded ${generated}/${toGenerate.length} OG images...`)
      }
    } catch (err) {
      genErrors++
      ogErrors.push({ slug, message: err.message })
      console.error(`  Error generating OG for ${slug}: ${err.message}`)
    }
  })

  // Remove images of removed events
  const removedImages = removed.filter(slug => existingOg.has(slug))
  if (removedImages.length) await removeOgs(cfg, removedImages)

  // Write the manifest last: a run that died above leaves the previous one in
  // place, and the next run redraws what it did not finish.
  await writeManifest(cfg, 'kalendarz', newManifest)
  const versionFile = stampPublish(PROJECT_ROOT, 'kalendarz', newSlugs.size)

  console.log('\n--- Apply Summary ---')
  console.log(`  OG images uploaded:  ${generated}`)
  console.log(`  OG image errors:     ${genErrors}`)
  console.log(`  OG images removed:   ${removedImages.length}`)
  console.log(`  Manifest uploaded:   ${MANIFEST_BUCKET}/kalendarz.json`)
  if (versionFile) console.log(`  Commit to deploy:    ${versionFile}`)

  const logFile = await writeRunLog('publish-event-pages', {
    script: 'publish-event-pages',
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    args: { regen_og: regenOg },
    total_events: newSlugs.size,
    added: added.length,
    changed: changed.length,
    removed: removed.length,
    unchanged,
    og_generated: generated,
    og_errors: genErrors,
    added_slugs: added,
    removed_slugs: removed,
    changed_slugs: changed,
    readdressed,
    og_error_details: ogErrors,
  })
  console.log(`  Run log:             ${logFile}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
