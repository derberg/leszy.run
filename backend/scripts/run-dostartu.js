import { runPipeline } from '../src/scrapers/index.js'

// Run only the dostartu scraper (writes to scraper_dostartu table)
runPipeline({ force: ['dostartu'], only: ['dostartu'] })
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
