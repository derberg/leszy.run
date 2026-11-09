import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchUrlWrite } from '../scripts/lib/ai-fillable.js'

// Warta Challenge (2027-01-02, maratonypolskie:91277). The Python enricher
// stamped enriched_at at 13:30 while registration_url was null. At 16:57
// run-enrich-search.js found the panel page and wrote only the URL, so the
// Python enricher never read it and the row published with distances=[],
// price_from and registration_deadline null.
test('a URL found by the search step re-queues the row for both enrichers', () => {
  const write = searchUrlWrite({
    registration_url: 'https://panel.maratonczykpomiarczasu.pl/warta-challenge-noworoczny-2027',
  })
  assert.equal(write.registration_url, 'https://panel.maratonczykpomiarczasu.pl/warta-challenge-noworoczny-2027')
  assert.equal(write.enriched_at, null)
  assert.equal(write.enriched_regulamin_at, null)
})

test('a deterministic regulamin fill also re-queues the row', () => {
  const write = searchUrlWrite({ regulamin_url: 'https://dostartu.pl/statute_files/1_pl.pdf' })
  assert.ok('enriched_at' in write && write.enriched_at === null)
  assert.ok('enriched_regulamin_at' in write && write.enriched_regulamin_at === null)
})
