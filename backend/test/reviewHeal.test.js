import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planHeal } from '../scripts/lib/reviewAgents.js'

// On 2026-09-18 the step merged one pull request, #162, which fixed the
// enricher's regulamin search and was measured against 60 rows. Then it healed
// nothing: healSources only recognised backend/src/scrapers/sources/<name>.js,
// so the log read "No source scraper changed" and all 60 rows kept the value the
// broken code had written. A merged fix that repairs no data is not a fix.

const radius = {
  table: 'scraper_all',
  filters: [{ column: 'source', op: 'eq', value: 'biegigorskie' }],
  future_only: true,
}

test('a scraper fix is healed by re-scraping that source', () => {
  const plan = planHeal([{ file: 'backend/src/scrapers/sources/foxter.js', blastRadius: 12, radius }])
  assert.deepEqual(plan.rescrape, ['foxter'])
  assert.deepEqual(plan.reenrich, [])
})

// The enricher only reads rows it has not enriched yet, so a corrected enricher
// never revisits the rows it got wrong. Clearing the stamps is what puts them
// back in its queue.
test('an enricher fix is healed by clearing the enrichment stamps on the rows it measured', () => {
  const plan = planHeal([{ file: 'enricher/enricher/steps/search.py', blastRadius: 60, radius }])
  assert.deepEqual(plan.rescrape, [])
  assert.equal(plan.reenrich.length, 1)
  assert.deepEqual(plan.reenrich[0].radius, radius)
  assert.deepEqual(plan.reenrich[0].columns, ['enriched_at', 'enriched_search_at', 'enriched_regulamin_at'])
})

// A fix to code the scrapers share only reaches the data on a full re-scrape,
// and the nightly pipeline does one every morning. Saying so is better than
// re-scraping thirty five sources at 2pm, and much better than silence.
test('shared code is left to the nightly re-scrape, and said so', () => {
  const plan = planHeal([
    { file: 'backend/src/lib/pickRegulaminUrl.js', blastRadius: 19, radius },
    { file: 'backend/src/scrapers/index.js', blastRadius: 4, radius },
  ])
  assert.deepEqual(plan.rescrape, [])
  assert.deepEqual(plan.reenrich, [])
  assert.equal(plan.nightly.length, 2)
  assert.match(plan.nightly[0].reason, /nightly/i)
})

test('a source is re-scraped once however many defects named it', () => {
  const plan = planHeal([
    { file: 'backend/src/scrapers/sources/foxter.js', blastRadius: 3, radius },
    { file: 'backend/src/scrapers/sources/foxter.js', blastRadius: 9, radius },
  ])
  assert.deepEqual(plan.rescrape, ['foxter'])
})

// A count that could not be taken is not a licence to clear stamps across the
// whole table. An unmeasured radius is reported instead.
test('an enricher fix with no measured radius is not turned into a blind update', () => {
  const plan = planHeal([{ file: 'enricher/enricher/pipeline.py', blastRadius: null, radius: null }])
  assert.deepEqual(plan.reenrich, [])
  assert.equal(plan.unhealed.length, 1)
  assert.match(plan.unhealed[0].reason, /radius/i)
})

test('nothing merged means nothing to do', () => {
  const plan = planHeal([])
  assert.deepEqual(plan.rescrape, [])
  assert.deepEqual(plan.reenrich, [])
  assert.deepEqual(plan.nightly, [])
})
