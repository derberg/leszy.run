import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterCalendarEvents, loadCalendarEvents } from '../../src/lib/calendarData.js'

const ev = (o) => ({ status: 'active', event_type: [], ...o })
const EVENTS = [
  ev({ id: 'a', name: 'Bieg Niepodległości', date: '2026-11-11', location: 'Kraków', voivodeship: 'Małopolskie', event_type: ['uliczny'], created_at: '2026-10-01T10:00:00+00:00' }),
  ev({ id: 'b', name: 'Nocny Zew Wilka', date: '2026-12-05', location: 'Łódź', voivodeship: 'Łódzkie', event_type: ['nocny', 'trail'], created_at: '2026-11-02T08:00:00Z' }),
  ev({ id: 'c', name: 'Sylwester', date: '2026-12-31', location: 'Gdańsk', voivodeship: 'Pomorskie', status: 'cancelled' }),
  ev({ id: 'd', name: 'Ukryty', date: '2026-11-20', location: 'Toruń', status: 'rejected' }),
]
const ids = list => list.map(e => e.id)

test('dates bound the range on both ends and the result is sorted by date', () => {
  assert.deepEqual(ids(filterCalendarEvents([...EVENTS].reverse(), { startDate: '2026-11-01' })), ['a', 'b', 'c'])
  assert.deepEqual(ids(filterCalendarEvents(EVENTS, { startDate: '2026-11-12', endDate: '2026-12-30' })), ['b'])
})

test('only active and cancelled races are listed', () => {
  assert.ok(!ids(filterCalendarEvents(EVENTS, {})).includes('d'))
})

test('search matches name or location case-insensitively, Polish letters included', () => {
  assert.deepEqual(ids(filterCalendarEvents(EVENTS, { search: 'NIEPODLEGŁ' })), ['a'])
  assert.deepEqual(ids(filterCalendarEvents(EVENTS, { search: 'łódź' })), ['b'])
  assert.deepEqual(ids(filterCalendarEvents(EVENTS, { search: 'a,b)' })), [])
})

test('types match any, regions match any, club ids restrict', () => {
  assert.deepEqual(ids(filterCalendarEvents(EVENTS, { types: ['trail', 'uliczny'] })), ['a', 'b'])
  assert.deepEqual(ids(filterCalendarEvents(EVENTS, { voivodeships: ['Pomorskie', 'Łódzkie'] })), ['b', 'c'])
  assert.deepEqual(ids(filterCalendarEvents(EVENTS, { ids: ['c'] })), ['c'])
  assert.deepEqual(ids(filterCalendarEvents(EVENTS, { ids: [] })), [])
})

test('"Dodane" compares instants, whatever the timestamp spelling', () => {
  assert.deepEqual(ids(filterCalendarEvents(EVENTS, { addedSince: '2026-11-01T00:00:00.000Z' })), ['b'])
})

test('loadCalendarEvents fetches once and retries after a failure', async () => {
  let calls = 0
  const failing = async () => { calls++; return { ok: false, status: 500 } }
  await assert.rejects(loadCalendarEvents(failing))
  const ok = async () => { calls++; return { ok: true, json: async () => EVENTS } }
  assert.equal((await loadCalendarEvents(ok)).length, 4)
  await loadCalendarEvents(ok)
  assert.equal(calls, 2)
})

test('the atest filter: a certified distance, inside the distance filter when it is on', async () => {
  const { hasCertifiedDistance, CALENDAR_FIELDS } = await import('../../src/lib/calendarData.js')
  assert.ok(CALENDAR_FIELDS.includes('atest'))
  const race = { distances: ['5 km', '21.1 km'], atest: [{ km: 5, certified_on: '2024-01-01', source: 'register' }] }
  assert.equal(hasCertifiedDistance(race), true)
  assert.equal(hasCertifiedDistance({ distances: ['5 km'], atest: null }), false)
  // „Półmaraton” + atest: the half is not the certified course here, the 5 km is.
  const half = (d) => d === '21.1 km'
  assert.equal(hasCertifiedDistance(race, half), false)
  assert.equal(hasCertifiedDistance(race, (d) => d === '5 km'), true)
})
