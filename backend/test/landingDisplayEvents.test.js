import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectDisplayEvents } from '../../public/scripts/lib/displayEvents.js'

// Every /listy/* page used to advertise a different number than it showed.
// Measured live on 2026-09-17:
//
//   /listy/darmowe      claimed  65   listed  76
//   /listy/dla-dzieci   claimed 255   listed 312
//   /listy/maratony     claimed  30   listed  34
//
// Always more listed than claimed, because two scripts disagreed about one
// thing: a race whose registration has closed. publish-landing-pages.js
// excluded it from the count; generate-landing-pages.js listed it anyway.
//
// The rule is now "has the race happened yet", and nothing else, so both
// scripts read selectDisplayEvents(). A closed sign-up still shows: the list
// is how Google reaches the /kalendarz/:slug pages, and an unenterable race
// still has a page worth indexing.

const TODAY = '2026-09-17'

const openSignup = { date: '2026-10-04', registration_deadline: '2026-09-29' }
const noDeadline = { date: '2026-10-11', registration_deadline: null }
const closedSignup = { date: '2026-10-25', registration_deadline: '2026-09-01' }
const racedYesterday = { date: '2026-09-16', registration_deadline: null }
const racesToday = { date: TODAY, registration_deadline: '2026-09-01' }

function select(entries) {
  const manifest = Object.fromEntries(entries.map((e, i) => [`slug-${i}`, e]))
  return selectDisplayEvents(manifest, TODAY).map(({ e }) => e.date)
}

test('lists a race you can still enter', () => {
  assert.deepEqual(select([openSignup]), ['2026-10-04'])
})

test('lists a race whose sign-up has closed but which has not happened', () => {
  // The decision this test exists for. 1720 of the 9072 event links these
  // pages emit are to races in this state.
  assert.deepEqual(select([closedSignup]), ['2026-10-25'])
})

test('lists a race that declares no deadline', () => {
  assert.deepEqual(select([noDeadline]), ['2026-10-11'])
  assert.deepEqual(select([{ date: '2026-10-11' }]), ['2026-10-11'])
})

test('drops a race that has already happened', () => {
  assert.deepEqual(select([racedYesterday]), [])
})

test('keeps a race happening today', () => {
  // gte, so the day of the race still counts as upcoming.
  assert.deepEqual(select([racesToday]), [TODAY])
})

test('the deadline never decides anything', () => {
  const withDeadlines = [openSignup, closedSignup, noDeadline]
  const stripped = withDeadlines.map(({ date }) => ({ date }))
  assert.deepEqual(select(withDeadlines), select(stripped))
})

test('sorts by date ascending', () => {
  assert.deepEqual(
    select([closedSignup, openSignup, noDeadline]),
    ['2026-10-04', '2026-10-11', '2026-10-25'],
  )
})

test('returns the slug alongside the event', () => {
  const picked = selectDisplayEvents({ 'bieg-x-2026-10-04': openSignup }, TODAY)
  assert.equal(picked.length, 1)
  assert.equal(picked[0].slug, 'bieg-x-2026-10-04')
  assert.equal(picked[0].e, openSignup)
})

test('what is listed is what publish-landing-pages counts', () => {
  const all = [openSignup, noDeadline, closedSignup, racedYesterday, racesToday]
  assert.equal(select(all).length, 4)
})
