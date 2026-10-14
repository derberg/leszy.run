// Run: node --test frontend/src/lib/participantOrder.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortParticipants } from './participantOrder.js'

// Listed by name, the way the categories API returns them; created in a different order.
const categories = [
  { id: 'cc', name: 'Canicross 21km', createdAt: '2026-10-14T19:01:40.271Z' },
  { id: 'nw', name: 'Nordic Walking 11km', createdAt: '2026-10-14T19:01:40.263Z' },
  { id: 'hm', name: 'Półmaraton 21km', createdAt: '2026-10-14T19:01:40.251Z' },
]

const p = (firstName, lastName, categoryId) => ({ firstName, lastName, categoryId })
const names = (rows) => rows.map(r => `${r.lastName} ${r.firstName}`)

test('groups by category in creation order, then last name, then first name', () => {
  const rows = sortParticipants([
    p('Monika', 'Bajko', 'hm'),
    p('Leszek', 'Babczyński', 'nw'),
    p('Aneta', 'Adamowicz', 'hm'),
    p('Janusz', 'Babczyński', 'nw'),
    p('Jagoda', 'Marzec', 'cc'),
  ], categories)
  assert.deepEqual(names(rows), [
    'Adamowicz Aneta', 'Bajko Monika',
    'Babczyński Janusz', 'Babczyński Leszek',
    'Marzec Jagoda',
  ])
})

test('uses Polish collation for last names', () => {
  const rows = sortParticipants([
    p('A', 'Łyzińska', 'hm'), p('A', 'Zawadzki', 'hm'), p('A', 'Lis', 'hm'), p('A', 'Ćwik', 'hm'), p('A', 'Dudek', 'hm'),
  ], categories)
  assert.deepEqual(names(rows), ['Ćwik A', 'Dudek A', 'Lis A', 'Łyzińska A', 'Zawadzki A'])
})

test('participants without a category go last; does not mutate input', () => {
  const input = [p('A', 'Adam', null), p('B', 'Zet', 'cc')]
  const rows = sortParticipants(input, categories)
  assert.deepEqual(names(rows), ['Zet B', 'Adam A'])
  assert.equal(input[0].lastName, 'Adam')
})

test('handles missing categories and names', () => {
  const rows = sortParticipants([p(null, 'B', 'x'), p('A', null, 'x')], undefined)
  assert.deepEqual(rows.map(r => r.lastName), [null, 'B'])
})
