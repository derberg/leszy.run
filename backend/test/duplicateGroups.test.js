import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupDuplicates, isDuplicatePair } from '../src/lib/duplicateGroups.js'

// Rows from the "Duplikaty" tab on 2026-10-28.
const ev = (id, name, location, date = '2026-11-11') => ({ id, name, location, date })

test('same-name races in different towns are not duplicates', () => {
  assert.equal(isDuplicatePair(
    ev('a', 'Bydgoski Bieg Niepodległości', 'Bydgoszcz'),
    ev('b', 'Poznański Bieg Niepodległości', 'Poznań'),
  ), false)
  assert.equal(isDuplicatePair(
    ev('a', 'Bieg Mikołajkowy 2026', 'Duszniki'),
    ev('b', 'Bieg Mikołajkowy 2026 - Orło', 'Orło'),
  ), false)
})

test('one race listed twice in one town is still offered', () => {
  assert.equal(isDuplicatePair(
    ev('a', 'XVIII BIEG NIEPODLEGŁOŚCI', 'Ciepielowice'),
    ev('b', 'XVIII BIEG NIEPODLEGŁOŚCI - Biegi Dzieci', 'Ciepielowice'),
  ), true)
  assert.equal(isDuplicatePair(
    ev('a', 'Wataha 7 km', 'Działdowo'),
    ev('b', 'Wataha 7 km Nordic Walking', 'Działdowo'),
  ), true)
})

test('a strong name match with no town still counts', () => {
  assert.equal(isDuplicatePair(
    ev('a', 'Gdyński Bieg Niepodległości', null),
    ev('b', 'Gdyński Bieg Niepodległości 2026', 'Gdynia'),
  ), true)
})

test('a row with no town does not chain two towns into one group', () => {
  const groups = groupDuplicates([
    ev('radom', 'Bieg Niepodległości', 'Radom'),
    ev('none', 'Bieg Niepodległości', null),
    ev('gdynia', 'Bieg Niepodległości', 'Gdynia'),
  ])
  for (const g of groups) {
    const towns = g.map(e => e.location).filter(Boolean)
    assert.ok(towns.length <= 1, `mixed towns in one group: ${towns}`)
  }
})

test('different dates never group, dismissed pairs never group', () => {
  assert.deepEqual(groupDuplicates([
    ev('a', 'Bieg Mikołajkowy', 'Police', '2026-12-06'),
    ev('b', 'Bieg Mikołajkowy', 'Police', '2026-12-07'),
  ]), [])
  assert.deepEqual(groupDuplicates([
    ev('a', 'Bieg Mikołajkowy', 'Police'),
    ev('b', 'Bieg Mikołajkowy', 'Police'),
  ], new Set(['a:b', 'b:a'])), [])
})
