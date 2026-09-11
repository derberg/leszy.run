import { test } from 'node:test'
import assert from 'node:assert/strict'
import { incomingWinsOver } from '../src/scrapers/index.js'

// SOURCE_PRIORITY: dostartu(1) … zmierzymyczas/b4sport etc. Lower number wins.
test('a higher-priority source replaces a lower-priority primary', () => {
  assert.equal(
    incomingWinsOver({ source: 'maratonypolskie', source_id: '88075' }, { source: 'dostartu', source_id: '17136' }),
    true,
  )
})

test('a lower-priority source only fills gaps', () => {
  assert.equal(
    incomingWinsOver({ source: 'dostartu', source_id: '17136' }, { source: 'maratonypolskie', source_id: '88075' }),
    false,
  )
})

test('a re-scrape of the same record wins — this is what lets a scraper fix land', () => {
  // The regression: zmierzymyczas 2663 had a consent form as its regulamin.
  // After the picker was fixed the raw table held the right URL, but the merge
  // compared zmierzymyczas against zmierzymyczas, called it a tie, and kept the
  // wrong value because it was non-empty.
  assert.equal(
    incomingWinsOver({ source: 'zmierzymyczas', source_id: '2663' }, { source: 'zmierzymyczas', source_id: '2663' }),
    true,
  )
})

test('a DIFFERENT record from the same source does not win', () => {
  // Same source, different event — that is an ordinary equal-priority merge,
  // not a refresh, so it must not overwrite.
  assert.equal(
    incomingWinsOver({ source: 'zmierzymyczas', source_id: '2663' }, { source: 'zmierzymyczas', source_id: '2496' }),
    false,
  )
})

test('an unknown source does not outrank a known one', () => {
  assert.equal(
    incomingWinsOver({ source: 'dostartu', source_id: '1' }, { source: 'brand-new-source', source_id: '1' }),
    false,
  )
})
