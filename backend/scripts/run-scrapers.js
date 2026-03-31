import { runPipeline } from '../src/scrapers/index.js'

// Usage: node run-scrapers.js [--force source1,source2] [--only source1,source2]
// Example: node run-scrapers.js --force dostartu
// Example: node run-scrapers.js --only timekeeper
// Example: node run-scrapers.js --only timekeeper --force timekeeper
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
  .then(results => {
    console.log('\n--- Summary ---')
    for (const s of results.sources) {
      const errStr = s.errors.length ? ` (${s.errors.length} errors)` : ''
      console.log(`  ${s.source}: found=${s.found} upserted=${s.upserted}${errStr}`)
      for (const e of s.errors) {
        console.log(`    ERR: ${e.message}`)
      }
    }
    process.exit(0)
  })
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
