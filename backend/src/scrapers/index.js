import { scrape as scrapeMaratonypolskie } from './sources/maratonypolskie.js'
import { scrape as scrapeDatasport } from './sources/datasport.js'
import { scrape as scrapeElektronicznezapisy } from './sources/elektronicznezapisy.js'
import { scrape as scrapeBiegiwpolsce } from './sources/biegiwpolsce.js'
import { normalizeEvent } from './normalizer.js'
import { upsertEvent } from './dedup.js'
import { resolveUrls } from './urlResolver.js'
import { enrichDistances } from './llmEnricher.js'

const sources = [
  { name: 'maratonypolskie', scrape: scrapeMaratonypolskie },
  { name: 'datasport', scrape: scrapeDatasport },
  { name: 'elektronicznezapisy', scrape: scrapeElektronicznezapisy },
  { name: 'biegiwpolsce', scrape: scrapeBiegiwpolsce },
]

async function runPipeline() {
  console.log('[pipeline] Starting scrape run...')
  const results = { sources: [], urlResolver: null }

  for (const source of sources) {
    const stats = { source: source.name, found: 0, created: 0, updated: 0, errors: [] }

    try {
      const rawEvents = await source.scrape()
      stats.found = rawEvents.length

      for (const raw of rawEvents) {
        try {
          const normalized = await normalizeEvent(raw)
          if (!normalized) {
            stats.errors.push({ raw: raw.name, message: 'Failed to normalize (no date?)' })
            continue
          }

          const { action, error } = await upsertEvent(normalized)
          if (error) {
            stats.errors.push({ raw: raw.name, message: error.message })
          } else if (action === 'created') {
            stats.created++
          } else {
            stats.updated++
          }
        } catch (err) {
          stats.errors.push({ raw: raw.name, message: err.message })
        }
      }
    } catch (err) {
      stats.errors.push({ raw: null, message: `Source failed: ${err.message}` })
    }

    results.sources.push(stats)
    console.log(`[pipeline] ${source.name}: found=${stats.found} new=${stats.created} updated=${stats.updated} errors=${stats.errors.length}`)
  }

  results.urlResolver = await resolveUrls()
  results.llmEnricher = await enrichDistances()
  console.log('[pipeline] Scrape run complete')
  return results
}

export { runPipeline }
