import { publishToCalendar } from '../src/scrapers/index.js'

// Usage: cd backend && node --env-file=../.env scripts/run-publish.js [--apply]
// Pushes scraper_all rows into calendar_events as 'pending'.
// Skips rows already in calendar_events (exact source+source_id match).
// No fuzzy dedup — use the Duplikaty view in admin UI to review dupes.
// Dry run by default — use --apply to write to DB.

const dryRun = !process.argv.includes('--apply')
if (dryRun) console.log('=== DRY RUN (use --apply to write to DB) ===\n')

publishToCalendar({ dryRun })
  .then(({ created, skipped, errors }) => {
    console.log('\n--- Publish Summary (scraper_all → calendar_events) ---')
    console.log(`  created=${created} skipped=${skipped} errors=${errors.length}`)
    for (const e of errors) {
      console.log(`    ERR: ${e.name || ''} ${e.message}`)
    }
    process.exit(0)
  })
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
