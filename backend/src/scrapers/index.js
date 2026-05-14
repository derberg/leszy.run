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
import { scrape as scrapeLumisport } from './sources/lumisport.js'
import { scrape as scrapeProtiming24 } from './sources/protiming24.js'
import { scrape as scrapeSuperczas } from './sources/superczas.js'
import { scrape as scrapeBgtimesport } from './sources/bgtimesport.js'
import { scrape as scrapeRajsportactive } from './sources/rajsportactive.js'
import { scrape as scrapeSporttime } from './sources/sporttime.js'
import { scrape as scrapeWbtiming } from './sources/wbtiming.js'
import { scrape as scrapeCzasomierzyk } from './sources/czasomierzyk.js'
import { SOURCE_PRIORITY, jaccardSimilarity, citiesMatch, tokenize, distinguishingTags, hasDistinguishingConflict } from './dedup.js'
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
      is_kids: raw.is_kids || false,
      price_from: raw.price_from ?? null,
      price_to: raw.price_to ?? null,
      registration_deadline: raw.registration_deadline || null,
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
      website: raw.website || null,
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
  {
    name: 'lumisport',
    scrape: scrapeLumisport,
    table: 'scraper_lumisport',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
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
    name: 'protiming24',
    scrape: scrapeProtiming24,
    table: 'scraper_protiming24',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      is_kids: raw.is_kids || false,
      event_types: raw.event_types && raw.event_types.length > 0 ? raw.event_types : null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'superczas',
    scrape: scrapeSuperczas,
    table: 'scraper_superczas',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      registration_deadline: raw.registration_deadline || null,
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      is_kids: raw.is_kids || false,
      event_types: raw.event_types && raw.event_types.length > 0 ? raw.event_types : null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'bgtimesport',
    scrape: scrapeBgtimesport,
    table: 'scraper_bgtimesport',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      is_kids: raw.is_kids || false,
      price_from: raw.price_from ?? null,
      price_to: raw.price_to ?? null,
      event_types: raw.event_types && raw.event_types.length > 0 ? raw.event_types : null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'rajsportactive',
    scrape: scrapeRajsportactive,
    table: 'scraper_rajsportactive',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      is_kids: raw.is_kids || false,
      event_types: raw.event_types && raw.event_types.length > 0 ? raw.event_types : null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'sporttime',
    scrape: scrapeSporttime,
    table: 'scraper_sporttime',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      is_kids: raw.is_kids || false,
      event_types: raw.event_types && raw.event_types.length > 0 ? raw.event_types : null,
      price_from: raw.price_from ?? null,
      price_to: raw.price_to ?? null,
      lat: raw.lat ?? null,
      lng: raw.lng ?? null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'wbtiming',
    scrape: scrapeWbtiming,
    table: 'scraper_wbtiming',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      is_kids: raw.is_kids || false,
      event_types: raw.event_types && raw.event_types.length > 0 ? raw.event_types : null,
      price_from: raw.price_from ?? null,
      price_to: raw.price_to ?? null,
      lat: raw.lat ?? null,
      lng: raw.lng ?? null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
  {
    name: 'czasomierzyk',
    scrape: scrapeCzasomierzyk,
    table: 'scraper_czasomierzyk',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      is_kids: raw.is_kids || false,
      event_types: raw.event_types && raw.event_types.length > 0 ? raw.event_types : null,
      price_from: raw.price_from ?? null,
      price_to: raw.price_to ?? null,
      lat: raw.lat ?? null,
      lng: raw.lng ?? null,
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
        const { error: deleteError } = await supabase.from(source.table).delete().not('id', 'is', null)
        if (deleteError) throw new Error(`Force clear failed: ${deleteError.message}`)
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
  // Dedupe by (source, source_id) pair — same source can legitimately have
  // multiple distinct registration URLs for one umbrella event (e.g. 5km/10km
  // variants). Matching only on source overwrites prior same-source entries.
  const idx = links.findIndex(l => l.source === newLink.source && l.source_id === newLink.source_id)
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
 * Returns { row, reason } or null. The reason string is for diagnostics —
 * "source_link" / "legacy_source" for exact matches, fuzzy matches expose
 * the threshold that fired (e.g. "city+jaccard=0.42") so a dry-run reader
 * can judge whether the merge is correct.
 */
async function findScraperAllMatch(event) {
  if (!supabase) return null

  // 1. Exact source match in source_links
  if (event.source_id) {
    const { data } = await supabase
      .from('scraper_all')
      .select('*')
      .contains('source_links', JSON.stringify([{ source: event.source, source_id: event.source_id }]))

    if (data && data.length > 0) return { row: data[0], reason: 'source_link' }

    // Legacy fallback
    const { data: legacy } = await supabase
      .from('scraper_all')
      .select('*')
      .eq('source', event.source)
      .eq('source_id', event.source_id)
      .single()

    if (legacy) return { row: legacy, reason: 'legacy_source' }
  }

  // 2. Cross-source fuzzy match: same date + name similarity. Collects ALL
  //    candidates that pass any threshold and returns the one with the highest
  //    jaccard. Prevents weaker fuzzy matches from "winning" just because they
  //    appeared earlier in the candidates list (e.g. when a kids run on the
  //    same day grabs the umbrella event before the actual race row is checked).
  const { data: candidates } = await supabase
    .from('scraper_all')
    .select('*')
    .eq('date', event.date)

  if (!candidates) return null

  let best = null  // { row, reason, score }
  const considerCandidate = (c, reason, score) => {
    if (!best || score > best.score) best = { row: c, reason, score }
  }

  // Pre-compute distinguishing tags for the incoming event (audience, distance,
  // style). Candidates with a tag conflict in any of these categories are
  // semantically distinct and must not merge regardless of name similarity.
  const eventTags = distinguishingTags(event)

  for (const c of candidates) {
    // Distinguishing-tag guard — kids vs adult, Półmaraton vs Maraton,
    // Bieg vs NW, etc. all rejected here even if jaccard is high.
    const candidateTags = distinguishingTags(c)
    if (hasDistinguishingConflict(eventTags, candidateTags)) continue

    const jaccard = jaccardSimilarity(c.name, event.name)
    const locMatch = citiesMatch(c.location, event.location)

    if (jaccard > 0.6) considerCandidate(c, `jaccard=${jaccard.toFixed(2)}`, jaccard)
    else if (locMatch && jaccard > 0.35) considerCandidate(c, `city+jaccard=${jaccard.toFixed(2)}`, jaccard)
    else if (locMatch && tokenize(c.name).length <= 3 && tokenize(event.name).length <= 3 && jaccard > 0.25) considerCandidate(c, `short+city+jaccard=${jaccard.toFixed(2)}`, jaccard)
    else if (locMatch) {
      // Short-vs-long name with same city: ≥75% of shorter tokens in longer (exact or prefix)
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
        if (tokC.length <= tokE.length && tokC.length <= 5 && containment(tokC, tokE) >= 0.75) considerCandidate(c, `containment(c→e)=${containment(tokC, tokE).toFixed(2)}`, jaccard)
        else if (tokE.length <= tokC.length && tokE.length <= 5 && containment(tokE, tokC) >= 0.75) considerCandidate(c, `containment(e→c)=${containment(tokE, tokC).toFixed(2)}`, jaccard)
      }
    }
  }

  return best ? { row: best.row, reason: best.reason } : null
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
    const stats = { source: source.name, total: 0, created: 0, updated: 0, skipped: 0, skippedReasons: { non_running: 0, past_date: 0, junk: 0 }, errors: [], createdNames: [], updatedNames: [], rows: [] }

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

          // maratonypolskie "Cross Maraton u Ryśka" (Wieluń) — repeatedly rejected, block by name pattern.
          const isRyskaJunk = source.name === 'maratonypolskie'
            && raw.name && /u\s+Ryśka\b/i.test(raw.name)

          // Skip non-running events and past events — mark merged so they don't re-appear
          if ((raw.name && SKIP_KEYWORDS.test(raw.name)) || (raw.date && raw.date < today) || isSmakMaratonJunk || isRyskaJunk) {
            stats.skipped++
            if (raw.name && SKIP_KEYWORDS.test(raw.name)) stats.skippedReasons.non_running++
            else if (raw.date && raw.date < today) stats.skippedReasons.past_date++
            else if (isSmakMaratonJunk || isRyskaJunk) stats.skippedReasons.junk++
            if (!dryRun) {
              await supabase.from(source.table).update({ merged_at: new Date().toISOString() }).eq('id', raw.id)
            }
            continue
          }

          // Snapshot raw row for dry-run quality reporting (post-skip)
          stats.rows.push({
            name: raw.name,
            date: raw.date,
            location: raw.location || null,
            voivodeship: raw.voivodeship || null,
            distances: raw.distances || null,
            event_types: raw.event_types || null,
            event_type: raw.event_type || null,
            is_kids: raw.is_kids || false,
            price_from: raw.price_from ?? null,
            price_to: raw.price_to ?? null,
            has_registration_url: !!raw.registration_url,
            has_regulamin_url: !!(raw.regulamin_url || (raw.regulamin_urls && raw.regulamin_urls[0])),
            has_website: !!(raw.website || raw.external_website),
            has_lat_lng: raw.lat != null && raw.lng != null,
            registration_deadline: raw.end_date || raw.registration_deadline || null,
            source_id: raw.source_id,
          })

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

          const match = await findScraperAllMatch(row)
          const existing = match?.row || null
          const matchReason = match?.reason || null
          const sourceLink = { source: source.name, source_id: raw.source_id, source_url: raw.source_url || null }
          const now = new Date().toISOString()

          if (existing) {
            const incomingPriority = getPriority(source.name)
            const existingPriority = getPriority(existing.source)
            const incomingWins = incomingPriority < existingPriority

            const updates = {}
            const overwrittenFields = []
            const filledFields = []
            const scraperAuthoritative = new Set(source.overwriteFields || [])
            for (const key of RAW_MERGE_FIELDS) {
              const newVal = row[key]
              if (newVal === null || newVal === undefined) continue
              if (Array.isArray(newVal) && newVal.length === 0) continue

              if (incomingWins || scraperAuthoritative.has(key)) {
                updates[key] = newVal
                if (!isEmpty(existing[key]) && JSON.stringify(existing[key]) !== JSON.stringify(newVal)) {
                  overwrittenFields.push(key)
                }
              } else if (isEmpty(existing[key])) {
                updates[key] = newVal
                filledFields.push(key)
              }
            }

            if (incomingWins) {
              updates.source = source.name
              updates.source_id = raw.source_id
              updates.source_url = raw.source_url || null
            }

            updates.source_links = mergeSourceLinks(existing.source_links, sourceLink)
            updates.merged_at = now

            // If new data landed (fill or overwrite), null out enrichment
            // timestamps so enrichers re-process the row. A fresh URL or
            // regulamin PDF can yield prices/deadlines/distances the
            // previous enrichment pass couldn't see.
            if (filledFields.length > 0 || overwrittenFields.length > 0) {
              updates.enriched_at = null
              updates.enriched_regulamin_at = null
              updates.enriched_search_at = null
            }

            const matchEntry = {
              raw_name: raw.name,
              raw_date: raw.date,
              raw_source_id: raw.source_id,
              raw_location: raw.location || null,
              matched_id: existing.id,
              matched_name: existing.name,
              matched_date: existing.date,
              matched_source: existing.source,
              matched_source_id: existing.source_id,
              matched_location: existing.location || null,
              reason: matchReason,
              incoming_wins: incomingWins,
              overwrite_fields: overwrittenFields,
              fill_fields: filledFields,
            }

            if (dryRun) {
              stats.updated++
              stats.updatedNames.push(matchEntry)
            } else {
              const { error } = await supabase
                .from('scraper_all')
                .update(updates)
                .eq('id', existing.id)

              if (error) stats.errors.push({ name: raw.name, message: error.message })
              else {
                stats.updated++
                stats.updatedNames.push(matchEntry)
                await supabase.from(source.table).update({ merged_at: now }).eq('id', raw.id)
              }
            }
          } else {
            row.source_links = [sourceLink]
            row.merged_at = now

            const createEntry = {
              name: raw.name,
              date: raw.date,
              location: raw.location || null,
              source_id: raw.source_id,
            }

            if (dryRun) {
              stats.created++
              stats.createdNames.push(createEntry)
            } else {
              const { error } = await supabase
                .from('scraper_all')
                .insert(row)

              if (error) stats.errors.push({ name: raw.name, message: error.message })
              else {
                stats.created++
                stats.createdNames.push(createEntry)
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

  // Fetch existing calendar_events with fields needed for both dedup AND
  // diff-based updates. Index by every source+source_id pair (primary + every
  // entry in source_links) so cross-source merges still find the existing row.
  // Rejected events are tracked separately so we never resurrect their data.
  const existingByLink = new Map()  // 'source:source_id' → ce row (active/pending only)
  const rejectedKeys = new Set()    // 'source:source_id' from rejected events
  from = 0
  while (true) {
    const { data, error } = await supabase
      .from('calendar_events')
      .select('id, name, date, status, source, source_id, source_links, locked_fields, location, voivodeship, lat, lng, distances, event_type, registration_url, regulamin_url, website, price_from, price_to, registration_deadline')
      .range(from, from + pageSize - 1)

    if (error) break
    if (!data || data.length === 0) break
    for (const r of data) {
      const keys = []
      if (r.source && r.source_id) keys.push(`${r.source}:${r.source_id}`)
      const links = Array.isArray(r.source_links) ? r.source_links : []
      for (const l of links) {
        if (l.source && l.source_id) keys.push(`${l.source}:${l.source_id}`)
      }
      if (r.status === 'rejected') {
        for (const k of keys) rejectedKeys.add(k)
      } else {
        for (const k of keys) existingByLink.set(k, r)
      }
    }
    if (data.length < pageSize) break
    from += pageSize
  }

  console.log(`[publish] ${existingByLink.size} live + ${rejectedKeys.size} rejected source+source_id pairs in calendar_events`)

  // Fetch name+date+location+event_type from calendar_events for fuzzy dedup.
  // event_type (which contains 'dzieci' when applicable) enables the
  // distinguishing-tag guard so we don't collapse semantically-distinct
  // events (kids vs adult, half vs full marathon).
  const existingByDate = new Map()
  from = 0
  while (true) {
    const { data, error } = await supabase
      .from('calendar_events')
      .select('id, name, date, location, event_type, source_links')
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

  function fuzzyMatch(saEvent, candidatesEvent) {
    // saEvent: { name, date, location, is_kids, event_types, event_type } from scraper_all
    // candidatesEvent same shape from CE (we pre-fetch event_type/is_kids for the dedup pool below)
    const candidates = existingByDate.get(saEvent.date)
    if (!candidates) return null
    const saTags = distinguishingTags(saEvent)
    for (const c of candidates) {
      // Same distinguishing-tag guard as the merge step — kids vs adult,
      // Maraton vs Półmaraton, trail vs uliczny, etc. Prevents publish from
      // suppressing a legitimate new CE row by misidentifying it as duplicate
      // of a semantically-distinct existing CE.
      if (hasDistinguishingConflict(saTags, distinguishingTags(c))) continue

      const jaccard = jaccardSimilarity(c.name, saEvent.name)
      if (jaccard > 0.6) return { matched: c, reason: `jaccard=${jaccard.toFixed(2)}` }
      const locMatch = citiesMatch(c.location, saEvent.location)
      if (locMatch && jaccard > 0.35) return { matched: c, reason: `city+jaccard=${jaccard.toFixed(2)}` }
      if (locMatch && tokenize(c.name).length <= 3 && tokenize(saEvent.name).length <= 3 && jaccard > 0.25) return { matched: c, reason: `short+city+jaccard=${jaccard.toFixed(2)}` }
    }
    return null
  }

  // Helper — given a calendar_events row and a fresh scraper_all row, build
  // the set of fields to update. Conservative rules to protect admin curation:
  //
  //   - Scalars (location, voivodeship, lat, lng, prices, deadline)
  //     and URLs (registration_url, regulamin_url, website):
  //       FILL IF EMPTY only — never overwrite existing values. If admin
  //       wants a fresh scraper value to win, they remove the CE value or
  //       lock-then-edit. Avoids regressing facebook→lumisport-or-back kind
  //       of decisions.
  //
  //   - distances (text[] in CE, comma string in scraper_all):
  //       FILL IF EMPTY, or UPGRADE if scraper has strictly more distances
  //       than CE (catches scrapers seeing newly-added race categories).
  //
  //   - event_type (text[]):
  //       ADDITIVE MERGE — never drop existing tags; add scraper's new ones
  //       and 'dzieci' if is_kids is true.
  //
  // Always respects ce.locked_fields.
  function buildUpdateRow(ce, raw) {
    const locked = new Set(Array.isArray(ce.locked_fields) ? ce.locked_fields : [])
    const upd = {}
    // Per-field decisions surfaced in the dry-run log so the operator can see
    // what data the publisher chose NOT to write. Each entry: { field, reason,
    // ce_value, sa_value }. Reasons: 'locked', 'already_populated', 'unchanged',
    // 'no_new_data', 'lower_count' (for distances), 'terrain_conflict' (event_type).
    const skipped = []

    function fillIfEmpty(field, newVal) {
      if (locked.has(field)) {
        if (newVal !== null && newVal !== undefined && newVal !== '') {
          skipped.push({ field, reason: 'locked', ce_value: ce[field], sa_value: newVal })
        }
        return
      }
      if (newVal === null || newVal === undefined) return
      if (typeof newVal === 'string' && !newVal.trim()) return
      const cur = ce[field]
      if (cur !== null && cur !== undefined && cur !== '') {
        // CE already has a value and it differs from sa value → silent drop
        // by design, but log it so the operator can spot mass-overrides.
        if (cur !== newVal) {
          skipped.push({ field, reason: 'already_populated', ce_value: cur, sa_value: newVal })
        }
        return
      }
      upd[field] = newVal
    }

    // Always-overwrite fields: scraper_all is authoritative; the value
    // changes over time (organizer raises the fee, registration opens new
    // tier) and the latest scrape should win. Locked fields still respected.
    function alwaysOverwrite(field, newVal) {
      if (locked.has(field)) {
        if (newVal !== null && newVal !== undefined) {
          skipped.push({ field, reason: 'locked', ce_value: ce[field], sa_value: newVal })
        }
        return
      }
      if (newVal === null || newVal === undefined) return
      if (ce[field] === newVal) return
      if (typeof ce[field] === 'number' && typeof newVal === 'number' && Number(ce[field]) === Number(newVal)) return
      upd[field] = newVal
    }

    fillIfEmpty('location', raw.location || null)
    fillIfEmpty('voivodeship', raw.voivodeship || null)
    fillIfEmpty('lat', raw.lat ?? null)
    fillIfEmpty('lng', raw.lng ?? null)
    fillIfEmpty('registration_url', raw.registration_url || null)
    fillIfEmpty('regulamin_url', raw.regulamin_url || null)
    fillIfEmpty('website', raw.website || null)
    fillIfEmpty('registration_deadline', raw.registration_deadline || null)
    alwaysOverwrite('price_from', raw.price_from ?? null)
    alwaysOverwrite('price_to', raw.price_to ?? null)

    // distances: scraper_all stores comma string, ce stores text[]
    if (locked.has('distances')) {
      const saRaw = raw.distances
      if (saRaw && (Array.isArray(saRaw) ? saRaw.length : String(saRaw).trim())) {
        skipped.push({ field: 'distances', reason: 'locked', ce_value: ce.distances, sa_value: saRaw })
      }
    } else {
      let saDistances = raw.distances || []
      if (!Array.isArray(saDistances)) {
        saDistances = String(saDistances).split(',').map(d => d.trim()).filter(Boolean)
      }
      const ceDistances = Array.isArray(ce.distances) ? ce.distances : []
      if (saDistances.length > 0) {
        if (ceDistances.length === 0 || saDistances.length > ceDistances.length) {
          upd.distances = saDistances
        } else if (saDistances.length === ceDistances.length) {
          // Same count — current rule is "no upgrade" so values are dropped if
          // CE already has same number, even when contents differ.
          if (!saDistances.every(d => ceDistances.includes(d))) {
            skipped.push({ field: 'distances', reason: 'same_count_different_values', ce_value: ceDistances, sa_value: saDistances })
          }
        } else {
          skipped.push({ field: 'distances', reason: 'lower_count', ce_value: ceDistances, sa_value: saDistances })
        }
      }
    }

    // event_type: additive merge (preserve curated tags), but never mix
    // conflicting terrain types — if CE says "trail", an incoming "uliczny"
    // is dropped (and vice versa). Add 'dzieci' from is_kids.
    if (locked.has('event_type')) {
      const saTypes = raw.event_types || raw.event_type
      if (saTypes && (Array.isArray(saTypes) ? saTypes.length : true)) {
        skipped.push({ field: 'event_type', reason: 'locked', ce_value: ce.event_type, sa_value: saTypes })
      }
    } else {
      const TERRAIN_TYPES = new Set(['trail', 'ocr', 'uliczny'])
      let saTypes = raw.event_types || raw.event_type || []
      if (!Array.isArray(saTypes)) saTypes = [saTypes]
      saTypes = saTypes.filter(Boolean)
      if (raw.is_kids && !saTypes.includes('dzieci')) saTypes.push('dzieci')
      if (saTypes.length > 0) {
        const ceTypes = Array.isArray(ce.event_type) ? ce.event_type : []
        const ceTerrain = ceTypes.find(t => TERRAIN_TYPES.has(t))
        const merged = new Set(ceTypes)
        const droppedTerrain = []
        for (const t of saTypes) {
          if (TERRAIN_TYPES.has(t) && ceTerrain && t !== ceTerrain) {
            droppedTerrain.push(t)
            continue
          }
          merged.add(t)
        }
        const mergedArr = [...merged]
        if (mergedArr.length !== ceTypes.length || !ceTypes.every(t => merged.has(t))) {
          upd.event_type = mergedArr
        }
        if (droppedTerrain.length > 0) {
          skipped.push({ field: 'event_type', reason: `terrain_conflict_with_${ceTerrain}`, ce_value: ce.event_type, sa_value: droppedTerrain })
        }
      }
    }

    return { upd, skipped }
  }

  let created = 0, updated = 0, unchanged = 0, rejectedSkipped = 0, fuzzySkipped = 0
  const errors = []
  const fuzzyLog = []
  const createdLog = []
  const updatedLog = []
  const now = new Date().toISOString()

  for (const raw of allRows) {
    // Resolve existing CE row by primary source or any source_links entry
    const links = Array.isArray(raw.source_links) ? raw.source_links : []
    const candidateKeys = []
    if (raw.source && raw.source_id) candidateKeys.push(`${raw.source}:${raw.source_id}`)
    for (const l of links) {
      if (l.source && l.source_id) candidateKeys.push(`${l.source}:${l.source_id}`)
    }

    // Rejected events: never insert OR update — admin killed them
    if (candidateKeys.some(k => rejectedKeys.has(k))) {
      rejectedSkipped++
      continue
    }

let existingCE = null
    for (const k of candidateKeys) {
      const found = existingByLink.get(k)
      if (found) { existingCE = found; break }
    }

    // Existing row → diff & update path
    if (existingCE) {
      const { upd, skipped: skippedFields } = buildUpdateRow(existingCE, raw)
      if (Object.keys(upd).length === 0) {
        unchanged++
        if (skippedFields.length > 0) {
          // Even when nothing was written, surface skipped fields so the operator
          // can spot data they expected to land but didn't.
          updatedLog.push({
            name: existingCE.name,
            date: existingCE.date,
            ce_id: existingCE.id,
            fields: [],
            skipped: skippedFields,
            no_op: true,
          })
        }
        continue
      }
      // Skip if we don't have a real id yet (just-inserted within this batch)
      if (!existingCE.id) {
        unchanged++
        continue
      }
      upd.last_verified_at = now

      if (dryRun) {
        updated++
        updatedLog.push({
          name: existingCE.name,
          date: existingCE.date,
          ce_id: existingCE.id,
          fields: Object.keys(upd).filter(k => k !== 'last_verified_at'),
          skipped: skippedFields,
        })
      } else {
        const { error } = await supabase
          .from('calendar_events')
          .update(upd)
          .eq('id', existingCE.id)
        if (error) {
          errors.push({ name: existingCE.name, message: `update failed: ${error.message}` })
        } else {
          updated++
          updatedLog.push({
            name: existingCE.name,
            date: existingCE.date,
            ce_id: existingCE.id,
            fields: Object.keys(upd).filter(k => k !== 'last_verified_at'),
            skipped: skippedFields,
          })
          // Refresh in-memory cache so a later scraper_all row matching the same
          // CE doesn't re-update with the same values
          for (const k of candidateKeys) existingByLink.set(k, { ...existingCE, ...upd })
        }
      }
      continue
    }

    // Fuzzy dedup: same date + similar name + same city already in calendar_events
    const fuzzy = fuzzyMatch(raw)
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
      // Stitch the scraper_all row into the matched CE's source_links so the
      // exact lookup finds it on the next run and fuzzy never fires again.
      if (!dryRun && fuzzy.matched.id && raw.source && raw.source_id) {
        const updatedLinks = mergeSourceLinks(fuzzy.matched.source_links, { source: raw.source, source_id: raw.source_id })
        await supabase.from('calendar_events').update({ source_links: updatedLinks }).eq('id', fuzzy.matched.id)
        existingByLink.set(`${raw.source}:${raw.source_id}`, { ...fuzzy.matched, source_links: updatedLinks })
      }
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
      price_from: raw.price_from ?? null,
      price_to: raw.price_to ?? null,
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
      const { data: inserted, error } = await supabase
        .from('calendar_events')
        .insert(row)
        .select('id')
        .single()

      if (error) {
        errors.push({ name: raw.name, message: error.message })
      } else {
        created++
        createdLog.push({ name: raw.name, date: raw.date, location: raw.location, voivodeship: raw.voivodeship, source: raw.source, source_id: raw.source_id })
        // Track so we don't insert dupes from same batch — also enables update path
        // for the just-inserted row if a later scraper_all row maps to the same CE.
        const insertedCE = {
          id: inserted?.id || null,
          name: raw.name,
          date: raw.date,
          location: raw.location || null,
          voivodeship: raw.voivodeship || null,
          distances,
          event_type: eventType,
          registration_url: raw.registration_url || null,
          regulamin_url: raw.regulamin_url || null,
          website: raw.website || null,
          price_from: raw.price_from ?? null,
          price_to: raw.price_to ?? null,
          registration_deadline: raw.registration_deadline || null,
          locked_fields: [],
        }
        if (raw.source && raw.source_id) existingByLink.set(`${raw.source}:${raw.source_id}`, insertedCE)
        for (const l of links) {
          if (l.source && l.source_id) existingByLink.set(`${l.source}:${l.source_id}`, insertedCE)
        }
        // Also track for fuzzy dedup within same batch
        const group = existingByDate.get(raw.date) || []
        group.push({ name: raw.name, date: raw.date, location: raw.location })
        existingByDate.set(raw.date, group)
      }
    }
  }

  console.log(`[publish] Done: created=${created} updated=${updated} unchanged=${unchanged} rejectedSkipped=${rejectedSkipped} fuzzySkipped=${fuzzySkipped} errors=${errors.length}`)

  if (fuzzyLog.length > 0) {
    console.log(`\n--- Fuzzy-skipped events (${fuzzyLog.length}) ---`)
    for (const f of fuzzyLog) {
      console.log(`  "${f.sa_name}" (${f.sa_source}:${f.sa_source_id}) on ${f.date}`)
      console.log(`    matched existing: "${f.ce_name}"`)
      console.log(`    sa_location: ${JSON.stringify(f.sa_location)} | ce_location: ${JSON.stringify(f.ce_location)}`)
      console.log(`    reason: ${f.reason}`)
    }
  }

  return { created, updated, unchanged, rejectedSkipped, fuzzySkipped, errors, fuzzyLog, createdLog, updatedLog }
}

export { runPipeline, mergeIntoScraperAll, publishToCalendar }
