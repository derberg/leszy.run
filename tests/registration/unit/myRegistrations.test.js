// W-87: „Moje zapisy” — shapeMyRegistrations, the pure half of the my-registrations function.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareEvents, shapeMyRegistrations } from '../../../supabase/functions/_shared/registration/myRegistrations.js'

const ME = 'me'
// 2026-11-02 12:00 in Warsaw.
const NOW = new Date('2026-11-02T11:00:00Z')

const settings = [
  { event_id: 'e-future', slug: 'bieg-przyszly', name: 'Bieg Przyszły', state: 'published', event_date: '2026-12-06', first_start_time: '10:00:00' },
  { event_id: 'e-soon', slug: 'bieg-wkrotce', name: 'Bieg Wkrótce', state: 'published', event_date: '2026-11-02', first_start_time: null },
  { event_id: 'e-past', slug: 'bieg-dawny', name: 'Bieg Dawny', state: 'closed', event_date: '2026-09-01', first_start_time: '09:30:00' },
  { event_id: 'e-older', slug: 'bieg-starszy', name: 'Bieg Starszy', state: 'closed', event_date: '2026-05-01', first_start_time: '09:30:00' },
  { event_id: 'e-draft', slug: 'szkic', name: 'Szkic', state: 'draft', event_date: '2026-12-01', first_start_time: null },
]
const competitions = [{ category_id: 'c1', name: 'Bieg 10 km' }, { category_id: 'c2', name: 'Bieg dzieci' }]
const reg = (over) => ({ category_id: 'c1', status: 'confirmed', first_name: 'Ola', last_name: 'Leśna', profile_id: null, created_at: '2026-10-01T10:00:00Z', ...over })
const order = (over) => ({ buyer_profile_id: ME, status: 'paid', total: 6000, expires_at: null, paid_at: '2026-10-01T10:05:00Z', created_at: '2026-10-01T10:00:00Z', ...over })

test('W-87 orders and people per event, upcoming soonest first then past latest first; drafts and dead rows left out', () => {
  const data = shapeMyRegistrations({
    userId: ME,
    settings,
    competitions,
    orders: [
      order({ id: 'o1', event_id: 'e-future' }),
      order({ id: 'o2', event_id: 'e-future', status: 'pending', paid_at: null, expires_at: '2026-11-05T10:00:00Z', created_at: '2026-10-02T10:00:00Z', total: 3000 }),
      order({ id: 'o3', event_id: 'e-future', status: 'expired' }),
      order({ id: 'o4', event_id: 'e-future', status: 'cancelled' }),
      order({ id: 'o5', event_id: 'e-draft' }),
      order({ id: 'o6', event_id: 'e-past', buyer_profile_id: 'someone-else' }),
    ],
    registrations: [
      reg({ id: 'r-kid', event_id: 'e-future', category_id: 'c2', first_name: 'Kuba', created_at: '2026-10-01T10:00:01Z' }),
      reg({ id: 'r-me', event_id: 'e-future', profile_id: ME, created_at: '2026-10-01T10:00:02Z' }),
      reg({ id: 'r-pend', event_id: 'e-future', status: 'pending_payment', first_name: 'Ala', created_at: '2026-10-02T10:00:00Z' }),
      reg({ id: 'r-cancel', event_id: 'e-future', status: 'cancelled' }),
      reg({ id: 'r-moved', event_id: 'e-future', status: 'transferred_out' }),
      reg({ id: 'r-soon', event_id: 'e-soon', profile_id: ME }),
      reg({ id: 'r-past', event_id: 'e-past', profile_id: ME }),
      reg({ id: 'r-older', event_id: 'e-older', profile_id: ME }),
      reg({ id: 'r-draft', event_id: 'e-draft', profile_id: ME }),
      reg({ id: 'r-unknown', event_id: 'e-nowhere', profile_id: ME }),
    ],
    now: NOW,
  })
  assert.deepEqual(data.map((e) => e.eventId), ['e-soon', 'e-future', 'e-past', 'e-older'])
  const future = data[1]
  assert.deepEqual(
    { slug: future.slug, eventName: future.eventName, eventDate: future.eventDate, firstStartTime: future.firstStartTime },
    { slug: 'bieg-przyszly', eventName: 'Bieg Przyszły', eventDate: '2026-12-06', firstStartTime: '10:00' },
  )
  assert.deepEqual(future.orders, [
    { id: 'o1', status: 'paid', total: 6000, expiresAt: null, paidAt: '2026-10-01T10:05:00Z', createdAt: '2026-10-01T10:00:00Z' },
    { id: 'o2', status: 'pending', total: 3000, expiresAt: '2026-11-05T10:00:00Z', paidAt: null, createdAt: '2026-10-02T10:00:00Z' },
  ])
  assert.deepEqual(future.people, [
    { id: 'r-me', firstName: 'Ola', lastName: 'Leśna', competition: 'Bieg 10 km', status: 'confirmed', mine: true },
    { id: 'r-kid', firstName: 'Kuba', lastName: 'Leśna', competition: 'Bieg dzieci', status: 'confirmed', mine: false },
    { id: 'r-pend', firstName: 'Ala', lastName: 'Leśna', competition: 'Bieg 10 km', status: 'pending_payment', mine: false },
  ])
  assert.deepEqual(data[2].orders, [], 'another buyer’s order is never listed')
  assert.equal(data[0].firstStartTime, null)
})

test('W-87 an event with only dead rows is left out; nothing at all is an empty list', () => {
  assert.deepEqual(shapeMyRegistrations({ userId: ME, settings, competitions, orders: [], registrations: [], now: NOW }), [])
  const data = shapeMyRegistrations({
    userId: ME, settings, competitions, now: NOW,
    orders: [order({ id: 'o1', event_id: 'e-future', status: 'expired' })],
    registrations: [reg({ id: 'r1', event_id: 'e-future', status: 'expired', profile_id: ME })],
  })
  assert.deepEqual(data, [])
})

test('W-87 a row seen twice (own entry and in an own order) is listed once; an order alone keeps its event', () => {
  const r = reg({ id: 'r1', event_id: 'e-future', profile_id: ME })
  const data = shapeMyRegistrations({
    userId: ME, settings, competitions, now: NOW,
    orders: [order({ id: 'o1', event_id: 'e-past' }), order({ id: 'o1', event_id: 'e-past' })],
    registrations: [r, { ...r }],
  })
  assert.equal(data.length, 2)
  assert.equal(data[0].people.length, 1)
  assert.equal(data[1].orders.length, 1)
  assert.deepEqual(data[1].people, [])
})

test('W-87 compareEvents: race day is upcoming, an undated event ends the upcoming ones', () => {
  const today = '2026-11-02'
  const ev = (eventId, eventDate) => ({ eventId, eventDate, eventName: eventId })
  const list = [ev('past1', '2026-10-01'), ev('none', null), ev('today', '2026-11-02'), ev('later', '2027-01-01'), ev('past2', '2026-10-30')]
  assert.deepEqual(list.sort((a, b) => compareEvents(a, b, today)).map((e) => e.eventId), ['today', 'later', 'none', 'past2', 'past1'])
})
