import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideDateMove, rowKeys } from '../src/lib/publishDateMove.js'

// run-publish used to fill only empty fields on an existing calendar_events
// row, so a race the source moved kept its old date on the public calendar
// forever. Measured 2026-11-08: "61 Cross Ostrzeszowski" (foxter) still read
// 2027-03-25 while scraper_all had 2027-04-25.

const TODAY = '2026-11-08'

const ce = (over = {}) => ({
  id: 'ce-1',
  name: '61 Cross Ostrzeszowski',
  date: '2027-03-25',
  status: 'active',
  source: 'foxter',
  source_id: '61-cross-ostrzeszowski',
  source_links: [],
  locked_fields: [],
  community_locked_fields: [],
  ...over,
})
const sa = (over = {}) => ({
  name: '61 Cross Ostrzeszowski',
  date: '2027-04-25',
  source: 'foxter',
  source_id: '61-cross-ostrzeszowski',
  source_links: [],
  ...over,
})

const decide = (over = {}) => decideDateMove({
  ce: ce(over.ce),
  sa: sa(over.sa),
  today: TODAY,
  saDates: over.saDates ?? new Set([sa(over.sa).date]),
  findCollision: over.findCollision ?? (() => null),
})

test('a future race moved to another future date takes the new date', () => {
  assert.deepEqual(decide(), { move: true, date: '2027-04-25' })
})

test('the same date is no decision at all', () => {
  assert.equal(decide({ sa: { date: '2027-03-25' } }), null)
  assert.equal(decide({ sa: { date: null } }), null)
})

test('an admin correction wins: date in locked_fields or community_locked_fields', () => {
  assert.deepEqual(decide({ ce: { locked_fields: ['date'] } }), { move: false, reason: 'locked' })
  assert.deepEqual(decide({ ce: { community_locked_fields: ['date'] } }), { move: false, reason: 'locked' })
})

test('a rejected or cancelled row is never moved', () => {
  assert.deepEqual(decide({ ce: { status: 'rejected' } }), { move: false, reason: 'rejected' })
  assert.deepEqual(decide({ ce: { status: 'cancelled' } }), { move: false, reason: 'cancelled' })
})

test('only the record the row was published from may move it, not a stitched link', () => {
  // "17 Legionowska Dycha": the CE row came from maratonypolskie; a merged
  // elektronicznezapisy row carrying that link said a week earlier.
  const r = decide({
    ce: { source: 'maratonypolskie', source_id: '86072', source_links: [{ source: 'zapisyonline', source_id: '1041' }], date: '2027-06-19' },
    sa: { source: 'zapisyonline', source_id: '1041', date: '2027-06-12' },
  })
  assert.deepEqual(r, { move: false, reason: 'not_primary_source' })
  // A merged row whose links contain the CE's own record does count.
  const ok = decide({
    ce: { source: 'maratonypolskie', source_id: '86072', date: '2027-06-19' },
    sa: { source: 'elektronicznezapisy', source_id: '15241', source_links: [{ source: 'maratonypolskie', source_id: '86072' }], date: '2027-06-12' },
  })
  assert.deepEqual(ok, { move: true, date: '2027-06-12' })
})

test('two scraper_all rows on one CE row that disagree on the date move nothing', () => {
  assert.deepEqual(
    decide({ saDates: new Set(['2027-04-25', '2027-03-25']) }),
    { move: false, reason: 'conflicting_sources' },
  )
})

test('never into the past', () => {
  assert.deepEqual(decide({ sa: { date: '2026-11-07' } }), { move: false, reason: 'moved_to_past' })
  assert.deepEqual(decide({ ce: { date: '2026-10-01' }, sa: { date: '2026-09-01' } }), { move: false, reason: 'moved_to_past' })
})

test('a past row moves only for a postponement, never to the next edition', () => {
  // "Rozbiegani w Gminie Kluki": 2026-09-27 on the calendar, the source says 2026-11-08.
  assert.deepEqual(decide({ ce: { date: '2026-09-27' }, sa: { date: '2026-11-08' } }), { move: true, date: '2026-11-08' })
  // A year on is a new edition reusing the id: the past row is history.
  assert.deepEqual(decide({ ce: { date: '2026-09-27' }, sa: { date: '2027-09-26' } }), { move: false, reason: 'past_edition' })
})

test('a move onto a date that already holds the same race is left for an admin', () => {
  const other = { id: 'ce-2', name: '61. Cross Ostrzeszowski', date: '2027-04-25' }
  const r = decide({ findCollision: (date, excludeId) => (date === '2027-04-25' && excludeId === 'ce-1' ? other : null) })
  assert.deepEqual(r, { move: false, reason: 'collides', collides_with: 'ce-2' })
})

test('rowKeys lists the primary record and every source link', () => {
  assert.deepEqual(
    rowKeys({ source: 'a', source_id: '1', source_links: [{ source: 'b', source_id: '2' }, { source: 'c' }] }),
    ['a:1', 'b:2'],
  )
  assert.deepEqual(rowKeys({ source: 'a', source_id: null, source_links: null }), [])
})
