import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldEmitRow } from '../src/scrapers/sources/zmierzymyczas.js'
import { changedKnownFields } from '../src/scrapers/index.js'

// A re-scrape is authoritative for its own record, so every field the scraper
// emits overwrites what is stored. fetchDetailPage returns null on ANY error —
// a timeout, a 502, a reset — and the row was still emitted with both URLs null.
// The re-check set is precisely the rows that have a regulamin but no
// registration yet, so one bad minute at the source erased a good regulamin PDF.
test('a failed detail fetch on a known row writes nothing', () => {
  assert.equal(shouldEmitRow(null, true), false)
})

test('a failed detail fetch on a new row still records the listing', () => {
  // Nothing is stored yet, so there is nothing to lose, and name/date/location
  // off the listing are worth keeping.
  assert.equal(shouldEmitRow(null, false), true)
})

test('a successful detail fetch always writes', () => {
  const detail = { regulaminUrl: 'https://x/r.pdf', registrationUrl: null }
  assert.equal(shouldEmitRow(detail, true), true)
  assert.equal(shouldEmitRow(detail, false), true)
})

// run-merge only reads raw rows where merged_at IS NULL, and the existing-row
// update deliberately preserves merged_at so an unchanged row is not re-merged
// every night. A re-check that RECOVERS a value therefore landed in the raw
// table and stopped there: scraper_all and calendar_events never saw it, which
// made the whole re-check invisible to users.
test('a recovered value clears merged_at so the merge reconsiders the row', () => {
  const known = { source_id: '2664', date: '2027-01-10', registration_url: null }
  const row = { source_id: '2664', date: '2027-01-10', registration_url: 'https://zmierzymyczas.pl/edit/2664/x.html' }
  assert.deepEqual(changedKnownFields(row, known, 'source_id,date,registration_url'), ['registration_url'])
})

test('an unchanged row keeps merged_at, so it is not re-merged every night', () => {
  const known = { source_id: '2664', date: '2027-01-10', registration_url: 'https://a/b' }
  const row = { source_id: '2664', date: '2027-01-10', registration_url: 'https://a/b' }
  assert.deepEqual(changedKnownFields(row, known, 'source_id,date,registration_url'), [])
})

test('a source that declares no knownColumns cannot diff, so nothing changes', () => {
  const row = { source_id: '7', name: 'X' }
  assert.deepEqual(changedKnownFields(row, { source_id: '7' }, null), [])
  assert.deepEqual(changedKnownFields(row, undefined, 'source_id,date'), [])
})

test('null and undefined are the same absence, so a field stays unchanged', () => {
  const known = { source_id: '1', registration_url: null }
  const row = { source_id: '1' }
  assert.deepEqual(changedKnownFields(row, known, 'source_id,registration_url'), [])
})
