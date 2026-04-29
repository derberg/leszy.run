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

function locationToString(loc) {
  if (!loc) return ''
  if (typeof loc === 'string') return loc
  if (typeof loc === 'object') {
    return [loc.city, loc.region, loc.country].filter(Boolean).join(', ') || JSON.stringify(loc)
  }
  return String(loc)
}

publishToCalendar({ dryRun })
  .then(async ({ created, skipped, fuzzySkipped, errors, createdLog }) => {
    if (createdLog && createdLog.length > 0) {
      console.log(`\n--- ${dryRun ? 'Would create' : 'Created'} ${createdLog.length} event(s) ---`)
      for (const c of createdLog) {
        const place = [locationToString(c.location), c.voivodeship].filter(Boolean).join(' / ')
        console.log(`  [${c.date}] ${c.name}${place ? ` — ${place}` : ''} (${c.source}:${c.source_id})`)
      }
    }
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
        created_events: (createdLog || []).map(c => ({
          name: c.name,
          date: c.date,
          location: c.location,
          voivodeship: c.voivodeship,
          source: c.source,
          source_id: c.source_id,
        })),
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
