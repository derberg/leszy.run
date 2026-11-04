// The public pages read the race calendar from build-time data, never from calendar_events.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  nearbyEvents, upcomingEvents, calendarRowsByLeszyrunId, landingEvents,
  parseEmbeddedEvent, loadKalendarzEvent,
} from '../../src/lib/calendarQueries.js'

const ev = (o) => ({ status: 'active', event_type: [], distances: [], registration_deadline: null, ...o })
const ids = (list) => list.map(e => e.id)

test('no file under public/src reads calendar_events with the publishable key', () => {
  const root = new URL('../../src/', import.meta.url).pathname
  const walk = (dir) => readdirSync(dir).flatMap(f => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
  const offenders = walk(root).filter(p => /\.(jsx?|mjs)$/.test(p)
    && /from\(\s*['"]calendar_events['"]\s*\)/.test(readFileSync(p, 'utf8')))
  assert.deepEqual(offenders, [])
})

test('nearby: same voivodeship, within 3 days, not past, not itself, at most 5, by date', () => {
  const event = { id: 'x', voivodeship: 'Śląskie', date: '2026-11-14' }
  const events = [
    ev({ id: 'x', voivodeship: 'Śląskie', date: '2026-11-14' }),
    ev({ id: 'a', voivodeship: 'Śląskie', date: '2026-11-16' }),
    ev({ id: 'b', voivodeship: 'Śląskie', date: '2026-11-11' }),
    ev({ id: 'past', voivodeship: 'Śląskie', date: '2026-11-11' }),
    ev({ id: 'far', voivodeship: 'Śląskie', date: '2026-11-18' }),
    ev({ id: 'other', voivodeship: 'Opolskie', date: '2026-11-14' }),
    ev({ id: 'cancelled', voivodeship: 'Śląskie', date: '2026-11-14', status: 'cancelled' }),
  ]
  assert.deepEqual(ids(nearbyEvents(events, event, '2026-11-01')), ['b', 'past', 'a'])
  assert.deepEqual(ids(nearbyEvents(events, event, '2026-11-12')), ['a'])
  const many = Array.from({ length: 8 }, (_, i) => ev({ id: `m${i}`, voivodeship: 'Śląskie', date: '2026-11-15' }))
  assert.equal(nearbyEvents(many, event, '2026-11-01').length, 5)
  assert.deepEqual(nearbyEvents(events, { id: 'x', date: '2026-11-14' }), [])
})

test('upcoming: the next races from today, listed statuses only', () => {
  const events = [
    ev({ id: 'c', date: '2026-12-01' }), ev({ id: 'a', date: '2026-11-05' }),
    ev({ id: 'old', date: '2026-11-01' }), ev({ id: 'p', date: '2026-11-06', status: 'pending' }),
    ev({ id: 'b', date: '2026-11-07', status: 'cancelled' }),
  ]
  assert.deepEqual(ids(upcomingEvents(events, '2026-11-04')), ['a', 'b', 'c'])
  assert.deepEqual(ids(upcomingEvents(events, '2026-11-04', 1)), ['a'])
})

test('banner rows are keyed by leszyrun_event_id, only the ones asked for', () => {
  const rows = [ev({ id: '1', leszyrun_event_id: 'L1' }), ev({ id: '2', leszyrun_event_id: 'L2' }), ev({ id: '3' })]
  assert.deepEqual(Object.keys(calendarRowsByLeszyrunId(rows, ['L1'])), ['L1'])
  assert.equal(calendarRowsByLeszyrunId(rows, ['L1', 'L2']).L2.id, '2')
})

test('landing: active, from today, registration open, filtered and paged with a total', () => {
  const today = '2026-11-04'
  const events = [
    ev({ id: 'a', date: '2026-11-10', voivodeship: 'Śląskie', event_type: ['trail'], location: 'Katowice' }),
    ev({ id: 'b', date: '2026-11-08', voivodeship: 'Śląskie', event_type: ['uliczny', 'dzieci'], location: 'Gliwice', price_from: 0 }),
    ev({ id: 'closed', date: '2026-11-09', registration_deadline: '2026-11-01' }),
    ev({ id: 'cancelled', date: '2026-11-09', status: 'cancelled' }),
    ev({ id: 'past', date: '2026-11-01' }),
    ev({ id: 'c', date: '2026-12-05', voivodeship: 'Opolskie', distances: ['21,1 km'], registration_deadline: '2026-11-10' }),
    ev({ id: 'd', date: '2026-12-06', distances: ['Maraton'] }),
  ]
  assert.deepEqual(landingEvents(events, {}, { today }), { events: events.filter(e => ['b', 'a', 'c', 'd'].includes(e.id)).sort((x, y) => x.date.localeCompare(y.date)), total: 4 })
  assert.deepEqual(ids(landingEvents(events, { regionDb: 'Śląskie' }, { today }).events), ['b', 'a'])
  assert.deepEqual(ids(landingEvents(events, { typeDbVal: 'trail' }, { today }).events), ['a'])
  assert.deepEqual(ids(landingEvents(events, { city: 'gliw' }, { today }).events), ['b'])
  assert.deepEqual(ids(landingEvents(events, { year: 2026, month: 12 }, { today }).events), ['c', 'd'])
  assert.deepEqual(ids(landingEvents(events, { special: 'dla-dzieci' }, { today }).events), ['b'])
  assert.deepEqual(ids(landingEvents(events, { special: 'darmowe' }, { today }).events), ['b'])
  assert.deepEqual(ids(landingEvents(events, { special: 'polmaratony' }, { today }).events), ['c'])
  assert.deepEqual(ids(landingEvents(events, { special: 'maratony' }, { today }).events), ['d'])
  assert.deepEqual(ids(landingEvents(events, { special: 'ostatnia-szansa' }, { today, now: Date.parse('2026-11-04T12:00:00Z') }).events), ['c'])
  const paged = landingEvents(events, {}, { today, page: 2, pageSize: 3 })
  assert.deepEqual(ids(paged.events), ['d'])
  assert.equal(paged.total, 4)
})

test('the race embedded in a pre-rendered page is read back, anything else is null', () => {
  const race = { id: 'r', name: 'Bieg </b>', date: '2026-11-11', status: 'active' }
  const html = `<html><body><script id="event-data" type="application/json">${JSON.stringify(race).replace(/<\//g, "<\\/")}</script></body></html>`
  assert.deepEqual(parseEmbeddedEvent(html), race)
  assert.equal(parseEmbeddedEvent('<html><div id="root"></div></html>'), null)
  assert.equal(parseEmbeddedEvent('<script id="event-data" type="application/json">{bad</script>'), null)
})

test('loadKalendarzEvent fetches the slug page and refuses an odd slug without fetching', async () => {
  const race = { id: 'r', name: 'Bieg', date: '2026-11-11' }
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    return { ok: true, text: async () => `<script id="event-data" type="application/json">${JSON.stringify(race)}</script>` }
  }
  assert.deepEqual(await loadKalendarzEvent('bieg-2026-11-11', fetchImpl), race)
  assert.deepEqual(seen, ['/kalendarz/bieg-2026-11-11/index.html'])
  assert.equal(await loadKalendarzEvent('../x', fetchImpl), null)
  assert.equal(await loadKalendarzEvent('bieg', async () => ({ ok: false })), null)
  assert.equal(seen.length, 1)
})
