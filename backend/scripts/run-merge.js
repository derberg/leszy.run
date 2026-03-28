import { mergeIntoScraperAll } from '../src/scrapers/index.js'

// Usage: cd backend && node --env-file=../.env scripts/run-merge.js
// Merges all raw scraper_* tables into scraper_all with priority-based dedup.
// dostartu wins over all, maratonypolskie loses to all.

mergeIntoScraperAll()
  .then(results => {
    console.log('\n--- Phase 1 Summary (raw → scraper_all) ---')
    for (const s of results.sources) {
      const errStr = s.errors.length ? ` (${s.errors.length} errors)` : ''
      console.log(`  ${s.source}: total=${s.total} created=${s.created} updated=${s.updated}${errStr}`)
      for (const e of s.errors) {
        console.log(`    ERR: ${e.name || ''} ${e.message}`)
      }
    }
    process.exit(0)
  })
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
