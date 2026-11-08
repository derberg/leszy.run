import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideDateMove, rowKeys, deadlineAfterMove, collectSaDates, refileByDate, applyDateMove, collisionFinder,
} from '../src/lib/publishDateMove.js'
import { fuzzyMatchIn } from '../src/scrapers/publishFuzzy.js'

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

// ─── The registration deadline follows a move ─────────────────────────────

test('a moved row takes the source deadline when it is on or before the new date', () => {
  // Kluki: 2026-09-27 → 2026-11-08 kept 2026-09-20.
  const row = ce({ date: '2026-09-27', registration_deadline: '2026-09-20' })
  assert.deepEqual(deadlineAfterMove(row, sa({ registration_deadline: '2026-11-01' }), '2026-11-08'), { write: true, value: '2026-11-01' })
  assert.deepEqual(deadlineAfterMove(row, sa({ registration_deadline: '2026-11-08' }), '2026-11-08'), { write: true, value: '2026-11-08' })
})

test('without a usable source deadline the old one is cleared, not kept', () => {
  const row = ce({ registration_deadline: '2026-09-20' })
  assert.deepEqual(deadlineAfterMove(row, sa({ registration_deadline: null }), '2026-11-08'), { write: true, value: null })
  assert.deepEqual(deadlineAfterMove(row, sa({ registration_deadline: '2026-12-01' }), '2026-11-08'), { write: true, value: null })
  assert.equal(deadlineAfterMove(ce({ registration_deadline: null }), sa(), '2026-11-08'), null)
})

test('an admin deadline stays through a move', () => {
  const r1 = deadlineAfterMove(ce({ registration_deadline: '2026-09-20', locked_fields: ['registration_deadline'] }), sa(), '2026-11-08')
  const r2 = deadlineAfterMove(ce({ registration_deadline: '2026-09-20', community_locked_fields: ['registration_deadline'] }), sa(), '2026-11-08')
  assert.deepEqual(r1, { write: false, reason: 'locked' })
  assert.deepEqual(r2, { write: false, reason: 'locked' })
})

// ─── The publishToCalendar wiring ─────────────────────────────────────────

test('collectSaDates gathers the date of every scraper_all row resolving to a CE row', () => {
  const row = ce()
  const existingByLink = new Map([['foxter:61-cross-ostrzeszowski', row], ['zapisyonline:9', row]])
  const rejectedKeys = new Set(['datasport:1'])
  const dates = collectSaDates([
    sa({ date: '2027-04-25' }),
    sa({ source: 'zapisyonline', source_id: '9', date: '2027-04-26' }),
    sa({ source: 'other', source_id: 'x', source_links: [{ source: 'foxter', source_id: '61-cross-ostrzeszowski' }], date: '2027-04-25' }),
    // a rejected row never counts, and neither does one with no CE row or no date
    sa({ source: 'datasport', source_id: '1', source_links: [{ source: 'foxter', source_id: '61-cross-ostrzeszowski' }], date: '2027-05-01' }),
    sa({ source: 'nobody', source_id: 'n', date: '2027-01-01' }),
    sa({ date: null }),
  ], existingByLink, rejectedKeys)
  assert.deepEqual([...dates.keys()], ['ce-1'])
  assert.deepEqual([...dates.get('ce-1')].sort(), ['2027-04-25', '2027-04-26'])
})

test('a moved row is re-filed under its new date, so later rows are compared with where it is', () => {
  const pool = new Map([['2027-03-25', [{ id: 'ce-1', name: '61 Cross Ostrzeszowski', date: '2027-03-25', status: 'active' }]]])
  assert.equal(refileByDate(pool, 'ce-1', '2027-03-25', '2027-04-25'), true)
  assert.deepEqual(pool.get('2027-03-25'), [])
  assert.equal(pool.get('2027-04-25')[0].date, '2027-04-25')
  // A second scraper_all row reaching the same decision changes nothing.
  assert.equal(refileByDate(pool, 'ce-1', '2027-03-25', '2027-04-25'), false)
  assert.equal(pool.get('2027-04-25').length, 1)
  // An unmatched source row for the same race on the new date now meets it.
  assert.equal(fuzzyMatchIn(pool, { name: '61 Cross Ostrzeszowski', date: '2027-04-25', location: null }).matched.id, 'ce-1')
})

test('the collision check sees a pending row of the same race; inserts still do not', () => {
  const pool = new Map([['2027-04-25', [{ id: 'ce-2', name: '61. Cross Ostrzeszowski', date: '2027-04-25', status: 'pending', location: 'Ostrzeszów' }]]])
  const find = collisionFinder(pool, ce({ location: 'Ostrzeszów' }), fuzzyMatchIn)
  assert.equal(find('2027-04-25', 'ce-1').id, 'ce-2')
  assert.equal(find('2027-04-25', 'ce-2'), null) // never itself
  assert.equal(fuzzyMatchIn(pool, { name: '61 Cross Ostrzeszowski', date: '2027-04-25', location: 'Ostrzeszów' }), null)
})

test('applyDateMove writes the date and deadline, and reports one line per CE row and date', () => {
  const row = ce({ date: '2026-09-27', registration_deadline: '2026-09-20' })
  const log = []
  const decision = { move: true, date: '2026-11-08' }
  const upd1 = {}
  applyDateMove({ ce: row, sa: sa({ date: '2026-11-08' }), decision, upd: upd1, skipped: [], log })
  assert.deepEqual(upd1, { date: '2026-11-08', registration_deadline: null })
  // The same CE row reached again by another scraper_all row with the same date.
  applyDateMove({ ce: row, sa: sa({ source: 'other', date: '2026-11-08' }), decision, upd: {}, skipped: [], log })
  assert.equal(log.length, 1)
  assert.deepEqual(log[0].deadline, { from: '2026-09-20', to: null })
  assert.equal(log[0].moved, true)
})

test('applyDateMove drops a filled deadline that falls after the new date', () => {
  // buildUpdateRow fills an empty deadline from the source; after a move it must not be later than the race.
  const upd = { registration_deadline: '2027-05-01' }
  applyDateMove({ ce: ce({ registration_deadline: null }), sa: sa({ registration_deadline: '2027-05-01' }), decision: { move: true, date: '2027-04-25' }, upd, skipped: [], log: [] })
  assert.deepEqual(upd, { date: '2027-04-25' })
})

test('a refused move is a skip and a report line, and writes nothing', () => {
  const upd = {}
  const skipped = []
  const log = []
  applyDateMove({ ce: ce({ date: '2026-08-23' }), sa: sa({ date: '2026-09-12' }), decision: { move: false, reason: 'moved_to_past' }, upd, skipped, log })
  assert.deepEqual(upd, {})
  assert.deepEqual(skipped, [{ field: 'date', reason: 'date_moved_to_past', ce_value: '2026-08-23', sa_value: '2026-09-12' }])
  assert.equal(log[0].reason, 'moved_to_past')
  assert.equal(log[0].deadline, null)
})
