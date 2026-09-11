import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dropsDistances } from '../scripts/lib/distances.js'

// Every pair below is real data from Kosakowo Biega (zapisyonline), a series that
// runs on the first Saturday of every month with one regulamin uploaded per edition.
// The scraper reads three races off the registration page; the rules document
// describes only the 5 km. Before this guard the document won, and the public
// calendar lost both kids races.

test('keeps the scraper set when the regulamin only subtracts', () => {
  assert.equal(dropsDistances('2 km, 5 km, 500 m', '5 km'), true)
  assert.equal(dropsDistances('2 km, 5 km', '5 km'), true)
})

test('lets the regulamin win when it adds a distance', () => {
  assert.equal(dropsDistances('5 km', '2 km, 5 km, 500 m'), false)
})

test('lets the regulamin win when it corrects a distance', () => {
  // A subtraction AND an addition is a correction, not a stale document.
  assert.equal(dropsDistances('10 km', '10,5 km'), false)
  assert.equal(dropsDistances('2 km, 5 km', '2 km, 5.5 km'), false)
})

test('is a no-op when either side is empty', () => {
  assert.equal(dropsDistances(null, '5 km'), false)
  assert.equal(dropsDistances('', '5 km'), false)
  assert.equal(dropsDistances('2 km, 5 km', null), false)
})

test('ignores spacing and case when comparing', () => {
  assert.equal(dropsDistances('2 KM,  5 km , 500 M', '5 km'), true)
  assert.equal(dropsDistances('2 km, 5 km', ' 2 km ,5 KM'), false)
})
