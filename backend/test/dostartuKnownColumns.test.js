import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changedKnownFields, sources } from '../src/scrapers/index.js'

// dostartu re-emits every known event on each run, and organizers upload the
// statute after listing the event. Without knownColumns the selective UPDATE
// kept merged_at, so the new regulamin_url stayed in scraper_dostartu and never
// reached scraper_all. Seen on 17534 (Rodzinny Bieg Niepodległości, Brzeszcze).
const dostartu = sources.find((s) => s.name === 'dostartu')

function mapped(overrides) {
  return dostartu.mapRow({
    name: 'Rodzinny Bieg Niepodległości 2026',
    date: '2026-11-11',
    source_id: '17534',
    distances: '1 km',
    registration_deadline: '2026-11-10',
    price_from: 0,
    price_to: 0,
    website: null,
    regulamin_url: null,
    ...overrides,
  })
}

test('a statute uploaded after the first scrape queues the dostartu row for re-merge', () => {
  const known = { source_id: '17534', regulamin_url: null, registration_deadline: '2026-11-10', distances: '1 km', price_from: 0, price_to: 0, website: null }
  const row = mapped({ regulamin_url: 'https://dostartu.pl/statute_files/17534_pl.pdf' })
  assert.deepEqual(changedKnownFields(row, known, dostartu.knownColumns), ['regulamin_url'])
})

test('a fee set after the first scrape queues the dostartu row for re-merge', () => {
  const known = { source_id: '17534', regulamin_url: null, registration_deadline: '2026-11-10', distances: '1 km', price_from: null, price_to: null, website: null }
  const row = mapped({ price_from: 10, price_to: 10 })
  assert.deepEqual(changedKnownFields(row, known, dostartu.knownColumns), ['price_from', 'price_to'])
})

test('an unchanged dostartu row keeps merged_at', () => {
  const known = { source_id: '17534', regulamin_url: null, registration_deadline: '2026-11-10', distances: '1 km', price_from: 0, price_to: 0, website: null }
  assert.deepEqual(changedKnownFields(mapped({}), known, dostartu.knownColumns), [])
})
