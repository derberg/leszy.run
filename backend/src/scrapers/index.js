import { scrape as scrapeMaratonypolskie } from './sources/maratonypolskie.js'
import { scrape as scrapeDatasport } from './sources/datasport.js'
import { scrape as scrapeElektronicznezapisy } from './sources/elektronicznezapisy.js'
import { scrape as scrapeBiegiwpolsce } from './sources/biegiwpolsce.js'
import { scrape as scrapeDostartu } from './sources/dostartu.js'
import { scrape as scrapeTimekeeper } from './sources/timekeeper.js'
import { scrape as scrapeSupersport } from './sources/supersport.js'
import { scrape as scrapeZmierzymyczas } from './sources/zmierzymyczas.js'
import { scrape as scrapeB4sport } from './sources/b4sport.js'
import { scrape as scrapeRaatiming } from './sources/raatiming.js'
import { SOURCE_PRIORITY, jaccardSimilarity, citiesMatch, tokenize } from './dedup.js'
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
      registration_url: raw.registration_url || null,
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
      registration_deadline: raw.registration_deadline || null,
      location: raw.location || null,
      lat: raw.lat || null,
      lng: raw.lng || null,
      distances: raw.distances || null,
      event_type: raw.event_type || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      is_kids: raw.is_kids || false,
      price_from: raw.price_from ?? null,
      price_to: raw.price_to ?? null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'timekeeper',
    scrape: scrapeTimekeeper,
    table: 'scraper_timekeeper',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'supersport',
    scrape: scrapeSupersport,
    table: 'scraper_supersport',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      is_kids: raw.is_kids || false,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'zmierzymyczas',
    scrape: scrapeZmierzymyczas,
    table: 'scraper_zmierzymyczas',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'b4sport',
    scrape: scrapeB4sport,
    table: 'scraper_b4sport',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'raatiming',
    scrape: scrapeRaatiming,
    table: 'scraper_raatiming',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
]

async function runPipeline({ force = [], only = [] } = {}) {
  if (!supabase) {
    console.error('[pipeline] Supabase not configured, cannot store scraped data')
    return { sources: [] }
  }

  console.log('[pipeline] Starting scrape run...')
  const results = { sources: [] }

  const activeSources = only.length
    ? sources.filter(s => only.includes(s.name))
    : sources

  for (const source of activeSources) {
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

      // Split into new rows (insert) and existing rows (selective update).
      // Full upsert on existing rows resets merged_at to null, causing
      // merge to re-process the same events every run.
      const newRows = rows.filter(r => !knownIds.has(r.source_id))
      const existingRows = rows.filter(r => knownIds.has(r.source_id))

      // Insert new rows
      for (let i = 0; i < newRows.length; i += 50) {
        const batch = newRows.slice(i, i + 50)
        const { error } = await supabase
          .from(source.table)
          .insert(batch)

        if (error) {
          stats.errors.push({ raw: null, message: `Batch insert failed: ${error.message}` })
        } else {
          stats.upserted += batch.length
        }
      }

      // Update existing rows but preserve merged_at so merge doesn't re-process them
      for (const row of existingRows) {
        const { source_id, ...fields } = row
        const { error } = await supabase
          .from(source.table)
          .update(fields)
          .eq('source_id', source_id)

        if (error) {
          stats.errors.push({ raw: row.name, message: `Update failed: ${error.message}` })
        } else {
          stats.upserted++
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
  'name', 'date', 'registration_deadline', 'location', 'voivodeship',
  'lat', 'lng', 'distances', 'event_type', 'event_types',
  'registration_url', 'regulamin_url', 'regulamin_urls', 'website',
  'is_kids', 'price_from', 'price_to',
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

    // Short-vs-long name with same city: ≥75% of shorter tokens in longer (exact or prefix)
    if (locMatch) {
      const tokC = tokenize(c.name)
      const tokE = tokenize(event.name)
      if (tokC.length >= 2 && tokE.length >= 2) {
        const containment = (shorter, longer) => {
          const setL = new Set(longer)
          let hits = 0
          for (const t of shorter) {
            if (setL.has(t)) { hits++; continue }
            if (longer.some(l => l.startsWith(t) || t.startsWith(l))) hits++
          }
          return hits / shorter.length
        }
        if (tokC.length <= tokE.length && tokC.length <= 5 && containment(tokC, tokE) >= 0.75) return c
        if (tokE.length <= tokC.length && tokE.length <= 5 && containment(tokE, tokC) >= 0.75) return c
      }
    }
  }

  return null
}

/**
 * Phase 1: Merge all raw scraper tables into scraper_all with priority-based dedup.
 * Processes sources in priority order (dostartu first).
 */
async function mergeIntoScraperAll({ dryRun = false } = {}) {
  if (!supabase) return { sources: [] }

  console.log('[merge:phase1] Merging raw tables → scraper_all...')

  // Skip non-running events (cycling, MTB, triathlon, gravel, SUP, skating, etc.)
  const SKIP_KEYWORDS = /\b(mtb|rowerow[aey]?|kolarsk[aie]?|kolarski|rajd rowerowy|triathlon|duathlon|aquathlon|gravel|gravelow[aey]?|enduro|sup race|wrotkars[a-z]*|jumping zoo|skill lab|turniej|3v3)\b/i

  const today = new Date().toISOString().split('T')[0]

  const sortedSources = [...sources].sort(
    (a, b) => (SOURCE_PRIORITY[a.name] ?? 99) - (SOURCE_PRIORITY[b.name] ?? 99)
  )

  const results = { sources: [] }

  for (const source of sortedSources) {
    const stats = { source: source.name, total: 0, created: 0, updated: 0, errors: [], createdNames: [], updatedNames: [] }

    try {
      // Fetch only unmerged rows from raw table (paginated)
      const allRows = []
      let from = 0
      const pageSize = 1000
      while (true) {
        const { data, error } = await supabase
          .from(source.table)
          .select('*')
          .is('merged_at', null)
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
          // maratonypolskie publishes "Smak Maraton" filler entries with leading "<num>-<num>" — junk, never merge.
          const isSmakMaratonJunk = source.name === 'maratonypolskie'
            && raw.name && /^\s*\d+-\d+\s+smak\s+maraton\b/i.test(raw.name)

          // Skip non-running events and past events — mark merged so they don't re-appear
          if ((raw.name && SKIP_KEYWORDS.test(raw.name)) || (raw.date && raw.date < today) || isSmakMaratonJunk) {
            if (!dryRun) {
              await supabase.from(source.table).update({ merged_at: new Date().toISOString() }).eq('id', raw.id)
            }
            continue
          }

          // Build a unified row from raw data + source-specific field mappings
          const row = {
            name: raw.name,
            date: raw.date,
            registration_deadline: raw.end_date || raw.registration_deadline || null,
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
            website: raw.website || raw.external_website || null,
            is_kids: raw.is_kids || false,
            price_from: raw.price_from ?? null,
            price_to: raw.price_to ?? null,
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

            if (dryRun) {
              stats.updated++
              stats.updatedNames.push(raw.name)
            } else {
              const { error } = await supabase
                .from('scraper_all')
                .update(updates)
                .eq('id', existing.id)

              if (error) stats.errors.push({ name: raw.name, message: error.message })
              else {
                stats.updated++
                stats.updatedNames.push(raw.name)
                await supabase.from(source.table).update({ merged_at: now }).eq('id', raw.id)
              }
            }
          } else {
            row.source_links = [sourceLink]
            row.merged_at = now

            if (dryRun) {
              stats.created++
              stats.createdNames.push(raw.name)
            } else {
              const { error } = await supabase
                .from('scraper_all')
                .insert(row)

              if (error) stats.errors.push({ name: raw.name, message: error.message })
              else {
                stats.created++
                stats.createdNames.push(raw.name)
                await supabase.from(source.table).update({ merged_at: now }).eq('id', raw.id)
              }
            }
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

/**
 * Phase 3: Push scraper_all rows into calendar_events.
 * No fuzzy dedup — just skip rows already present (exact source_links match).
 * New rows go in as 'pending' for admin review.
 */
async function publishToCalendar({ dryRun = false } = {}) {
  if (!supabase) return { created: 0, skipped: 0, errors: [{ message: 'Supabase not configured' }] }

  console.log('[publish] Reading scraper_all...')

  // Fetch all scraper_all rows (paginated)
  const allRows = []
  let from = 0
  const pageSize = 1000
  while (true) {
    const { data, error } = await supabase
      .from('scraper_all')
      .select('*')
      .range(from, from + pageSize - 1)

    if (error) return { created: 0, skipped: 0, errors: [{ message: `Fetch failed: ${error.message}` }] }
    if (!data || data.length === 0) break
    allRows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  console.log(`[publish] ${allRows.length} rows in scraper_all`)

  // Fetch all existing source+source_id pairs from calendar_events to skip exact matches.
  // Must also index source_links — merge can reassign the primary source/source_id on
  // scraper_all rows, so the primary pair alone is not enough for dedup.
  const existingLinks = new Set()
  from = 0
  while (true) {
    const { data, error } = await supabase
      .from('calendar_events')
      .select('source, source_id, source_links')
      .range(from, from + pageSize - 1)

    if (error) break
    if (!data || data.length === 0) break
    for (const r of data) {
      if (r.source && r.source_id) existingLinks.add(`${r.source}:${r.source_id}`)
      const links = Array.isArray(r.source_links) ? r.source_links : []
      for (const l of links) {
        if (l.source && l.source_id) existingLinks.add(`${l.source}:${l.source_id}`)
      }
    }
    if (data.length < pageSize) break
    from += pageSize
  }

  console.log(`[publish] ${existingLinks.size} existing source+source_id pairs in calendar_events`)

  // Fetch name+date+location from calendar_events for fuzzy dedup.
  // New scraper_all rows may have slightly different names from events already published
  // in a prior run (source row merged/deleted since then), so source_link matching misses them.
  const existingByDate = new Map()
  from = 0
  while (true) {
    const { data, error } = await supabase
      .from('calendar_events')
      .select('name, date, location')
      .in('status', ['active', 'rejected'])
      .range(from, from + pageSize - 1)

    if (error) break
    if (!data || data.length === 0) break
    for (const r of data) {
      const group = existingByDate.get(r.date) || []
      group.push(r)
      existingByDate.set(r.date, group)
    }
    if (data.length < pageSize) break
    from += pageSize
  }

  console.log(`[publish] ${[...existingByDate.values()].reduce((s, g) => s + g.length, 0)} calendar_events loaded for fuzzy dedup`)

  function fuzzyMatch(name, date, location) {
    const candidates = existingByDate.get(date)
    if (!candidates) return null
    for (const c of candidates) {
      const jaccard = jaccardSimilarity(c.name, name)
      if (jaccard > 0.6) return { matched: c, reason: `jaccard=${jaccard.toFixed(2)}` }
      const locMatch = citiesMatch(c.location, location)
      if (locMatch && jaccard > 0.35) return { matched: c, reason: `city+jaccard=${jaccard.toFixed(2)}` }
      if (locMatch && tokenize(c.name).length <= 3 && tokenize(name).length <= 3 && jaccard > 0.25) return { matched: c, reason: `short+city+jaccard=${jaccard.toFixed(2)}` }
    }
    return null
  }

  let created = 0, skipped = 0, fuzzySkipped = 0
  const errors = []
  const fuzzyLog = []
  const createdLog = []
  const now = new Date().toISOString()

  for (const raw of allRows) {
    // Skip if primary source already in calendar_events
    if (raw.source && raw.source_id && existingLinks.has(`${raw.source}:${raw.source_id}`)) {
      skipped++
      continue
    }

    // Also check all source_links
    const links = Array.isArray(raw.source_links) ? raw.source_links : []
    const anyLinkExists = links.some(l => l.source && l.source_id && existingLinks.has(`${l.source}:${l.source_id}`))
    if (anyLinkExists) {
      skipped++
      continue
    }

    // Fuzzy dedup: same date + similar name + same city already in calendar_events
    const fuzzy = fuzzyMatch(raw.name, raw.date, raw.location)
    if (fuzzy) {
      fuzzySkipped++
      fuzzyLog.push({
        sa_name: raw.name,
        sa_source: raw.source,
        sa_source_id: raw.source_id,
        date: raw.date,
        sa_location: raw.location,
        ce_name: fuzzy.matched.name,
        ce_location: fuzzy.matched.location,
        reason: fuzzy.reason,
      })
      continue
    }

    // Normalize event_type to array and represent kids as an explicit type.
    // calendar_events has no is_kids column in current schema.
    let eventType = raw.event_types || raw.event_type || []
    if (!Array.isArray(eventType)) {
      eventType = [eventType]
    }
    eventType = eventType.filter(Boolean)
    if (raw.is_kids) {
      const base = Array.isArray(eventType) ? eventType : []
      if (!base.includes('dzieci')) {
        base.push('dzieci')
      }
      eventType = base
    }
    let distances = raw.distances || []
    if (!Array.isArray(distances)) {
      distances = String(distances)
        .split(',')
        .map(d => d.trim())
        .filter(Boolean)
    }

    const row = {
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      voivodeship: raw.voivodeship || null,
      lat: raw.lat || null,
      lng: raw.lng || null,
      event_type: eventType,
      distances,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      registration_deadline: raw.registration_deadline || null,
      price_from: raw.price_from || null,
      price_to: raw.price_to || null,
      website: raw.website || null,
      source: raw.source,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
      source_links: links,
      status: 'pending',
      scraped_at: now,
      last_verified_at: now,
    }

    if (dryRun) {
      created++
      createdLog.push({ name: raw.name, date: raw.date, location: raw.location, voivodeship: raw.voivodeship, source: raw.source, source_id: raw.source_id })
    } else {
      const { error } = await supabase
        .from('calendar_events')
        .insert(row)

      if (error) {
        errors.push({ name: raw.name, message: error.message })
      } else {
        created++
        createdLog.push({ name: raw.name, date: raw.date, location: raw.location, voivodeship: raw.voivodeship, source: raw.source, source_id: raw.source_id })
        // Track so we don't insert dupes from same batch
        if (raw.source && raw.source_id) existingLinks.add(`${raw.source}:${raw.source_id}`)
        for (const l of links) {
          if (l.source && l.source_id) existingLinks.add(`${l.source}:${l.source_id}`)
        }
        // Also track for fuzzy dedup within same batch
        const group = existingByDate.get(raw.date) || []
        group.push({ name: raw.name, date: raw.date, location: raw.location })
        existingByDate.set(raw.date, group)
      }
    }
  }

  console.log(`[publish] Done: created=${created} skipped=${skipped} fuzzySkipped=${fuzzySkipped} errors=${errors.length}`)

  if (fuzzyLog.length > 0) {
    console.log(`\n--- Fuzzy-skipped events (${fuzzyLog.length}) ---`)
    for (const f of fuzzyLog) {
      console.log(`  "${f.sa_name}" (${f.sa_source}:${f.sa_source_id}) on ${f.date}`)
      console.log(`    matched existing: "${f.ce_name}"`)
      console.log(`    sa_location: ${JSON.stringify(f.sa_location)} | ce_location: ${JSON.stringify(f.ce_location)}`)
      console.log(`    reason: ${f.reason}`)
    }
  }

  return { created, skipped, fuzzySkipped, errors, fuzzyLog, createdLog }
}

export { runPipeline, mergeIntoScraperAll, publishToCalendar }
