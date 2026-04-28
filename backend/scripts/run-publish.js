import { publishToCalendar } from '../src/scrapers/index.js'
import { writeRunLog } from './lib/run-log.js'

// Usage: cd backend && node --env-file=../.env scripts/run-publish.js [--apply]
// Pushes scraper_all rows into calendar_events as 'pending'.
// Skips rows already in calendar_events (exact source+source_id match).
// No fuzzy dedup — use the Duplikaty view in admin UI to review dupes.
// Dry run by default — use --apply to write to DB.

const startedAt = new Date().toISOString()
const dryRun = !process.argv.includes('--apply')
if (dryRun) console.log('=== DRY RUN (use --apply to write to DB) ===\n')

publishToCalendar({ dryRun })
  .then(async ({ created, skipped, fuzzySkipped, errors }) => {
    console.log('\n--- Publish Summary (scraper_all → calendar_events) ---')
    console.log(`  created=${created} skipped=${skipped} fuzzySkipped=${fuzzySkipped || 0} errors=${errors.length}`)
    for (const e of errors) {
      console.log(`    ERR: ${e.name || ''} ${e.message}`)
    }
    if (!dryRun) {
      const logFile = await writeRunLog('publish', {
        script: 'publish',
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        created,
        skipped,
        fuzzy_skipped: fuzzySkipped || 0,
        errors: errors.map(e => ({ name: e.name || null, message: String(e.message || e) })),
      })
      console.log(`\nRun log: ${logFile}`)
    }
    process.exit(0)
  })
  .catch(async err => {
    console.error(err)
    await writeRunLog('publish', {
      script: 'publish',
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      crashed: true,
      error: { message: String(err.message || err), stack: err.stack || null },
    }).catch(() => {})
    process.exit(1)
  })
