import { scrape as scrapeMaratonypolskie } from './sources/maratonypolskie.js'
import { scrape as scrapeDatasport } from './sources/datasport.js'
import { scrape as scrapeElektronicznezapisy } from './sources/elektronicznezapisy.js'
import { scrape as scrapeBiegiwpolsce } from './sources/biegiwpolsce.js'
import { scrape as scrapeDostartu } from './sources/dostartu.js'
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
      // Fetch existing source_ids so scrapers can skip detail pages for known events
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

      // Upsert in batches of 50
      const rows = []
      for (const raw of rawEvents) {
        try {
          const row = source.mapRow(raw)
          if (row.name && row.date) rows.push(row)
        } catch (err) {
          stats.errors.push({ raw: raw.name, message: err.message })
        }
      }

      // Upsert by source_id (on conflict update all fields)
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

  // NOTE: dedup, URL resolver, and LLM enricher are NOT run automatically.
  // Run them manually via separate scripts when ready.
  console.log('[pipeline] Scrape run complete (raw data stored in source tables)')
  return results
}

export { runPipeline }
