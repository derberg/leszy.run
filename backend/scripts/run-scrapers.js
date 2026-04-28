import { runPipeline } from '../src/scrapers/index.js'
import { writeRunLog } from './lib/run-log.js'

// Usage: node run-scrapers.js [--force source1,source2] [--only source1,source2]
// Example: node run-scrapers.js --force dostartu
// Example: node run-scrapers.js --only timekeeper
// Example: node run-scrapers.js --only timekeeper --force timekeeper
const startedAt = new Date().toISOString()
const forceIdx = process.argv.indexOf('--force')
const force = forceIdx !== -1 && process.argv[forceIdx + 1]
  ? process.argv[forceIdx + 1].split(',').map(s => s.trim())
  : []

const onlyIdx = process.argv.indexOf('--only')
const only = onlyIdx !== -1 && process.argv[onlyIdx + 1]
  ? process.argv[onlyIdx + 1].split(',').map(s => s.trim())
  : []

if (force.length) {
  console.log(`Force re-scrape: ${force.join(', ')}`)
}
if (only.length) {
  console.log(`Only running: ${only.join(', ')}`)
}

runPipeline({ force, only })
  .then(async results => {
    console.log('\n--- Summary ---')
    const sources = []
    for (const s of results.sources) {
      const errStr = s.errors.length ? ` (${s.errors.length} errors)` : ''
      console.log(`  ${s.source}: found=${s.found} upserted=${s.upserted}${errStr}`)
      for (const e of s.errors) {
        console.log(`    ERR: ${e.message}`)
      }
      sources.push({
        source: s.source,
        found: s.found,
        upserted: s.upserted,
        errors: s.errors.map(e => ({ message: String(e.message || e) })),
      })
    }
    const logFile = await writeRunLog('scrapers', {
      script: 'scrapers',
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      args: { force, only },
      sources,
      totals: {
        found: sources.reduce((a, s) => a + s.found, 0),
        upserted: sources.reduce((a, s) => a + s.upserted, 0),
        errors: sources.reduce((a, s) => a + s.errors.length, 0),
      },
    })
    console.log(`\nRun log: ${logFile}`)
    process.exit(0)
  })
  .catch(async err => {
    console.error(err)
    await writeRunLog('scrapers', {
      script: 'scrapers',
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      args: { force, only },
      crashed: true,
      error: { message: String(err.message || err), stack: err.stack || null },
    }).catch(() => {})
    process.exit(1)
  })
