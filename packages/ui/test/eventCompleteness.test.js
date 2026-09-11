import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REQUIRED_FIELDS,
  isFieldDecided,
  missingRequiredFields,
  missingTrackedFields,
  isReadyToAccept,
  isIncomplete,
} from '../src/lib/eventCompleteness.js'

const complete = {
  location: 'Kosakowo',
  voivodeship: 'Pomorskie',
  event_type: ['uliczny'],
  distances: ['5 km'],
  registration_url: 'https://example.pl/zapisy',
  regulamin_url: 'https://example.pl/regulamin.pdf',
  registration_deadline: '2026-10-01',
  price_from: 40,
  website: 'https://example.pl',
}

test('a fully filled row is ready and not incomplete', () => {
  assert.equal(isReadyToAccept(complete), true)
  assert.equal(isIncomplete(complete), false)
  assert.deepEqual(missingRequiredFields(complete), [])
})

test('website is tracked but never blocks readiness', () => {
  const row = { ...complete, website: null }
  assert.equal(isReadyToAccept(row), true)
  assert.equal(isIncomplete(row), true)
  assert.deepEqual(missingTrackedFields(row), ['website'])
})

test('each required field blocks readiness on its own', () => {
  for (const field of REQUIRED_FIELDS) {
    const row = { ...complete, [field]: null }
    assert.equal(isReadyToAccept(row), false, `${field} should block`)
    assert.deepEqual(missingRequiredFields(row), [field])
  }
})

// The "brak" button is how an operator records that a race genuinely has no
// regulamin. Without this the row is incomplete forever and the review agents
// re-investigate a settled question every night.
test('a locked empty field counts as decided', () => {
  const row = { ...complete, regulamin_url: null, locked_fields: ['regulamin_url'] }
  assert.equal(isFieldDecided(row, 'regulamin_url'), true)
  assert.equal(isReadyToAccept(row), true)
})

test('empty arrays and blank strings are absent, not present', () => {
  assert.equal(isReadyToAccept({ ...complete, distances: [] }), false)
  assert.equal(isReadyToAccept({ ...complete, location: '   ' }), false)
})

// price_from: 0 means a free race. It is a real answer and must not read as absent.
test('price_from 0 is a value', () => {
  assert.equal(isReadyToAccept({ ...complete, price_from: 0 }), true)
})

// scraper rows carry location as an object; calendar_events carries text.
test('an all-empty location object is absent', () => {
  assert.equal(isReadyToAccept({ ...complete, location: { city: null, region: null } }), false)
  assert.equal(isReadyToAccept({ ...complete, location: { city: 'Oława' } }), true)
})

test('a row missing everything lists every required field', () => {
  assert.deepEqual(missingRequiredFields({}), REQUIRED_FIELDS)
})
