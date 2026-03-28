import { scrape } from '../src/scrapers/sources/dostartu.js'
import { normalizeEvent } from '../src/scrapers/normalizer.js'
import { upsertEvent } from '../src/scrapers/dedup.js'

async function main() {
  console.log('[dostartu] Starting scrape...')
  const rawEvents = await scrape()
  console.log(`[dostartu] Got ${rawEvents.length} raw events, normalizing and upserting...`)

  let created = 0, updated = 0, skipped = 0, errors = 0

  for (const raw of rawEvents) {
    try {
      const normalized = await normalizeEvent(raw)
      if (!normalized) { skipped++; continue }

      // New dostartu events go in as pending for review
      normalized.status = normalized.status || 'pending'

      const { action, error } = await upsertEvent(normalized)
      if (error) {
        console.error(`  ERR: ${raw.name} — ${error.message}`)
        errors++
      } else if (action === 'created') {
        created++
      } else if (action === 'updated') {
        updated++
      } else {
        skipped++
      }
    } catch (err) {
      console.error(`  ERR: ${raw.name} — ${err.message}`)
      errors++
    }
  }

  console.log(`[dostartu] Done: ${created} new, ${updated} updated, ${skipped} skipped, ${errors} errors`)
}

main().catch(console.error)
