import { scrape as scrapeMaratonypolskie } from './sources/maratonypolskie.js'
import { scrape as scrapeDatasport } from './sources/datasport.js'
import { scrape as scrapeElektronicznezapisy } from './sources/elektronicznezapisy.js'
import { scrape as scrapeBiegiwpolsce } from './sources/biegiwpolsce.js'
import { scrape as scrapeDostartu } from './sources/dostartu.js'
import { SOURCE_PRIORITY } from './dedup.js'
import { supabase } from '../lib/supabaseClient.js'

const sources = [
  {
    name: 'maratonypolskie',
    scrape: scrapeMaratonypolskie,
    table: 'scraper_maratonypolskie',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      source_id: raw.source_id || null,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'datasport',
    scrape: scrapeDatasport,
    table: 'scraper_datasport',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      regulamin_url: raw.regulamin_url || null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'elektronicznezapisy',
    scrape: scrapeElektronicznezapisy,
    table: 'scraper_elektronicznezapisy',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_urls: raw.regulamin_urls && raw.regulamin_urls.length > 0 ? raw.regulamin_urls : null,
      external_website: raw.external_website || null,
      known_source_link: raw.known_source_link || null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'biegiwpolsce',
    scrape: scrapeBiegiwpolsce,
    table: 'scraper_biegiwpolsce',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      voivodeship: raw.voivodeship || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      event_types: raw.event_types && raw.event_types.length > 0 ? raw.event_types : null,
      is_kids: raw.is_kids || false,
      known_source_link: raw.known_source_link || null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'dostartu',
    scrape: scrapeDostartu,
    table: 'scraper_dostartu',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      end_date: raw.end_date || null,
      location: raw.location || null,
      lat: raw.lat || null,
      lng: raw.lng || null,
      distances: raw.distances || null,
      event_type: raw.event_type || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      is_kids: raw.is_kids || false,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
]

async function runPipeline({ force = [] } = {}) {
  if (!supabase) {
    console.error('[pipeline] Supabase not configured, cannot store scraped data')
    return { sources: [] }
  }

  console.log('[pipeline] Starting scrape run...')
  const results = { sources: [] }

  for (const source of sources) {
    const stats = { source: source.name, found: 0, upserted: 0, errors: [] }

    try {
      const isForced = force.includes(source.name)
      let knownIds = new Set()
      if (isForced) {
        await supabase.from(source.table).delete().neq('id', '')
        console.log(`[pipeline] ${source.name}: FORCE mode — cleared table`)
      } else {
        const { data: existing } = await supabase
          .from(source.table)
          .select('source_id')
        knownIds = new Set((existing || []).map(r => r.source_id))
        console.log(`[pipeline] ${source.name}: ${knownIds.size} events already in DB`)
      }

      const rawEvents = await source.scrape({ knownIds })
      stats.found = rawEvents.length

      const rows = []
      for (const raw of rawEvents) {
        try {
          const row = source.mapRow(raw)
          if (row.name && row.date) rows.push(row)
        } catch (err) {
          stats.errors.push({ raw: raw.name, message: err.message })
        }
      }

      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50)
        const { error } = await supabase
          .from(source.table)
          .upsert(batch, { onConflict: 'source_id' })

        if (error) {
          stats.errors.push({ raw: null, message: `Batch upsert failed: ${error.message}` })
        } else {
          stats.upserted += batch.length
        }
      }
    } catch (err) {
      stats.errors.push({ raw: null, message: `Source failed: ${err.message}` })
    }

    results.sources.push(stats)
    console.log(`[pipeline] ${source.name}: found=${stats.found} upserted=${stats.upserted} errors=${stats.errors.length}`)
  }

  console.log('[pipeline] Scrape run complete (raw data stored in source tables)')
  return results
}

// --- Helpers for scraper_all dedup ---

import { jaccardSimilarity, citiesMatch, tokenize } from './dedup.js'

function isEmpty(val) {
  return val === null || val === undefined ||
    (Array.isArray(val) && val.length === 0) ||
    val === ''
}

/**
 * Fields that the scraper_all dedup can overwrite when a higher-priority source arrives.
 * These are raw fields before normalization.
 */
const RAW_MERGE_FIELDS = [
  'name', 'date', 'end_date', 'location', 'voivodeship',
  'lat', 'lng', 'distances', 'event_type', 'event_types',
  'registration_url', 'regulamin_url', 'regulamin_urls', 'website',
  'is_kids',
]

function mergeSourceLinks(existingLinks, newLink) {
  const links = Array.isArray(existingLinks) ? [...existingLinks] : []
  const idx = links.findIndex(l => l.source === newLink.source)
  if (idx >= 0) {
    links[idx] = newLink
  } else {
    links.push(newLink)
  }
  return links
}

function getPriority(source) {
  return SOURCE_PRIORITY[source] ?? 99
}

/**
 * Find a match in scraper_all for the given raw event.
 */
async function findScraperAllMatch(event) {
  if (!supabase) return null

  // 1. Exact source match in source_links
  if (event.source_id) {
    const { data } = await supabase
      .from('scraper_all')
      .select('*')
      .contains('source_links', JSON.stringify([{ source: event.source, source_id: event.source_id }]))

    if (data && data.length > 0) return data[0]

    // Legacy fallback
    const { data: legacy } = await supabase
      .from('scraper_all')
      .select('*')
      .eq('source', event.source)
      .eq('source_id', event.source_id)
      .single()

    if (legacy) return legacy
  }

  // 2. Cross-source fuzzy match: same date + name similarity
  const { data: candidates } = await supabase
    .from('scraper_all')
    .select('*')
    .eq('date', event.date)

  if (!candidates) return null

  for (const c of candidates) {
    const jaccard = jaccardSimilarity(c.name, event.name)
    const locMatch = citiesMatch(c.location, event.location)

    if (jaccard > 0.6) return c
    if (locMatch && jaccard > 0.35) return c
    if (locMatch && jaccardSimilarity(c.name, event.name) > 0.4) return c
    if (locMatch && tokenize(c.name).length <= 3 && tokenize(event.name).length <= 3 && jaccard > 0.25) return c
  }

  return null
}

/**
 * Phase 1: Merge all raw scraper tables into scraper_all with priority-based dedup.
 * Processes sources in priority order (dostartu first).
 */
async function mergeIntoScraperAll() {
  if (!supabase) return { sources: [] }

  console.log('[merge:phase1] Merging raw tables → scraper_all...')

  const sortedSources = [...sources].sort(
    (a, b) => (SOURCE_PRIORITY[a.name] ?? 99) - (SOURCE_PRIORITY[b.name] ?? 99)
  )

  const results = { sources: [] }

  for (const source of sortedSources) {
    const stats = { source: source.name, total: 0, created: 0, updated: 0, errors: [] }

    try {
      // Fetch all rows from raw table (paginated)
      const allRows = []
      let from = 0
      const pageSize = 1000
      while (true) {
        const { data, error } = await supabase
          .from(source.table)
          .select('*')
          .range(from, from + pageSize - 1)

        if (error) { stats.errors.push({ message: `Fetch failed: ${error.message}` }); break }
        if (!data || data.length === 0) break
        allRows.push(...data)
        if (data.length < pageSize) break
        from += pageSize
      }

      stats.total = allRows.length
      console.log(`[merge:phase1] ${source.name}: processing ${allRows.length} raw events`)

      for (const raw of allRows) {
        try {
          // Build a unified row from raw data + source-specific field mappings
          const row = {
            name: raw.name,
            date: raw.date,
            end_date: raw.end_date || null,
            location: raw.location || null,
            voivodeship: raw.voivodeship || null,
            lat: raw.lat || null,
            lng: raw.lng || null,
            distances: raw.distances || null,
            event_type: raw.event_type || null,
            event_types: raw.event_types || null,
            registration_url: raw.registration_url || null,
            regulamin_url: raw.regulamin_url || (raw.regulamin_urls && raw.regulamin_urls[0]) || null,
            regulamin_urls: raw.regulamin_urls || null,
            website: raw.external_website || null,
            is_kids: raw.is_kids || false,
            source: source.name,
            source_id: raw.source_id,
            source_url: raw.source_url || null,
          }

          const existing = await findScraperAllMatch(row)
          const sourceLink = { source: source.name, source_id: raw.source_id, source_url: raw.source_url || null }
          const now = new Date().toISOString()

          if (existing) {
            const incomingPriority = getPriority(source.name)
            const existingPriority = getPriority(existing.source)
            const incomingWins = incomingPriority < existingPriority

            const updates = {}
            for (const key of RAW_MERGE_FIELDS) {
              const newVal = row[key]
              if (newVal === null || newVal === undefined) continue
              if (Array.isArray(newVal) && newVal.length === 0) continue

              if (incomingWins) {
                updates[key] = newVal
              } else if (isEmpty(existing[key])) {
                updates[key] = newVal
              }
            }

            if (incomingWins) {
              updates.source = source.name
              updates.source_id = raw.source_id
              updates.source_url = raw.source_url || null
            }

            updates.source_links = mergeSourceLinks(existing.source_links, sourceLink)
            updates.merged_at = now

            const { error } = await supabase
              .from('scraper_all')
              .update(updates)
              .eq('id', existing.id)

            if (error) stats.errors.push({ name: raw.name, message: error.message })
            else stats.updated++
          } else {
            row.source_links = [sourceLink]
            row.merged_at = now

            const { error } = await supabase
              .from('scraper_all')
              .insert(row)

            if (error) stats.errors.push({ name: raw.name, message: error.message })
            else stats.created++
          }
        } catch (err) {
          stats.errors.push({ name: raw.name, message: err.message })
        }
      }
    } catch (err) {
      stats.errors.push({ message: `Source failed: ${err.message}` })
    }

    results.sources.push(stats)
    console.log(`[merge:phase1] ${source.name}: created=${stats.created} updated=${stats.updated} errors=${stats.errors.length}`)
  }

  return results
}

export { runPipeline, mergeIntoScraperAll }
