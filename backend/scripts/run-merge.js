import { mergeIntoScraperAll } from '../src/scrapers/index.js'
import { writeRunLog } from './lib/run-log.js'

// Usage: cd backend && node --env-file=../.env scripts/run-merge.js [--apply]
// Merges all raw scraper_* tables into scraper_all with priority-based dedup.
// dostartu wins over all, maratonypolskie loses to all.
// Dry run by default — use --apply to write to DB.

const startedAt = new Date().toISOString()
const dryRun = !process.argv.includes('--apply')
if (dryRun) console.log('=== DRY RUN (use --apply to write to DB) ===\n')

mergeIntoScraperAll({ dryRun })
  .then(async results => {
    console.log('\n--- Phase 1 Summary (raw → scraper_all) ---')
    for (const s of results.sources) {
      const errStr = s.errors.length ? ` (${s.errors.length} errors)` : ''
      console.log(`  ${s.source}: total=${s.total} created=${s.created} deduped_within_run=${s.updated}${errStr}`)
      for (const name of s.createdNames) {
        console.log(`    + ${name}`)
      }
      for (const name of s.updatedNames) {
        console.log(`    ~ ${name}`)
      }
      for (const e of s.errors) {
        console.log(`    ERR: ${e.name || ''} ${e.message}`)
      }
    }
    const totals = results.sources.reduce((acc, s) => {
      acc.total += s.total; acc.created += s.created; acc.updated += s.updated; acc.errors += s.errors.length
      return acc
    }, { total: 0, created: 0, updated: 0, errors: 0 })
    console.log(`\n  TOTAL: total=${totals.total} created=${totals.created} deduped_within_run=${totals.updated} errors=${totals.errors}`)
    if (!dryRun) {
      const logFile = await writeRunLog('merge', {
        script: 'merge',
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        sources: results.sources.map(s => ({
          source: s.source,
          total: s.total,
          created: s.created,
          deduped_within_run: s.updated,
          createdNames: s.createdNames,
          updatedNames: s.updatedNames,
          errors: s.errors.map(e => ({ name: e.name || null, message: String(e.message || e) })),
        })),
        totals,
      })
      console.log(`\nRun log: ${logFile}`)
    }
    process.exit(0)
  })
  .catch(async err => {
    console.error(err)
    await writeRunLog('merge', {
      script: 'merge',
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      crashed: true,
      error: { message: String(err.message || err), stack: err.stack || null },
    }).catch(() => {})
    process.exit(1)
  })
