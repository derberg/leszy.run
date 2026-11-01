import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  competitionRow, newCompetitionRow, competitionsSection, assignIds, capacityLabel, capacityUnit, eventCapacity, priceText,
} from '../../src/lib/competitionRows.js'

const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'

const server = (over = {}) => ({
  categoryId: ID1, name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distanceLabel: '9 km',
  startTime: '10:00:00', capacity: 80, minAge: 16, maxAge: null, isKids: false, timed: true,
  gpxUploadId: null, hiddenAt: null, taken: 0, priceGrosze: null, ...over,
})

test('a server competition becomes a form row with text inputs and its last saved item', () => {
  const r = competitionRow(server({ priceGrosze: 6050 }))
  assert.equal(r.startTime, '10:00')
  assert.equal(r.capacity, '80')
  assert.equal(r.minAge, '16')
  assert.equal(r.maxAge, '')
  assert.equal(r.price, '60,50')
  assert.equal(r.hidden, false)
  assert.equal(r.saved.categoryId, ID1)
  assert.equal(priceText(6000), '60')
  assert.equal(priceText(null), '')
})

test('draft: whole rows are sent without `hidden`; a new unfinished row is left out', () => {
  const rows = [competitionRow(server()), { ...newCompetitionRow(), name: 'Bieg 3 km' }]
  const s = competitionsSection(rows, { pricingMode: 'free', state: 'draft' })
  assert.equal(s.value.items.length, 1)
  assert.equal('hidden' in s.value.items[0], false)
  assert.deepEqual(s.sentKeys, [rows[0].key])
  assert.equal(s.rowErrors[rows[1].key].capacity, 'Podaj limit miejsc.')
  assert.equal(s.ok, true)
})

test('a saved row mid-edit sends its last whole value, so it is never deleted by a half-typed edit', () => {
  const row = competitionRow(server())
  const s = competitionsSection([{ ...row, capacity: '' }], { pricingMode: 'free', state: 'draft' })
  assert.equal(s.value.items[0].capacity, 80)
  assert.equal(s.value.items[0].categoryId, ID1)
})

test('published: every competition is sent, hidden ones with hidden: true, the rest with hidden: false', () => {
  const rows = [competitionRow(server()), competitionRow(server({ categoryId: ID2, name: 'Marsz', hiddenAt: '2026-10-29T10:00:00Z' }))]
  const s = competitionsSection(rows, { pricingMode: 'free', state: 'published' })
  assert.deepEqual(s.value.items.map((i) => [i.categoryId, i.hidden]), [[ID1, false], [ID2, true]])
  // a hidden row mid-edit still goes, with its saved value and its flag
  const edited = competitionsSection([rows[0], { ...rows[1], name: '' }], { pricingMode: 'free', state: 'published' })
  assert.deepEqual(edited.value.items.map((i) => [i.name, i.hidden]), [['Bieg 9 km', false], ['Marsz', true]])
})

test('fixed pricing needs a price on every row', () => {
  const rows = [competitionRow(server())]
  const missing = competitionsSection(rows, { pricingMode: 'fixed', state: 'draft' })
  assert.equal(missing.ok, false)
  const priced = competitionsSection([{ ...rows[0], price: '60,5' }], { pricingMode: 'fixed', state: 'draft' })
  assert.equal(priced.ok, true)
  assert.equal(priced.value.items[0].price, '60,5')
})

test('ids from a save reach the rows that were sent without one, and their saved values', () => {
  const a = { ...newCompetitionRow(), name: 'A', capacity: '10' }
  const b = { ...newCompetitionRow(), name: 'B', capacity: '20' }
  const s = competitionsSection([a, b], { pricingMode: 'free', state: 'draft' })
  const rows = assignIds(s.rows, s.sentKeys, [ID1, ID2])
  assert.deepEqual(rows.map((r) => [r.categoryId, r.saved.categoryId]), [[ID1, ID1], [ID2, ID2]])
})

test('the event limit is the sum of the visible competitions\' limits', () => {
  const rows = [competitionRow(server()), competitionRow(server({ categoryId: ID2, capacity: 40, hiddenAt: 'x' })),
    { ...newCompetitionRow(), capacity: '20' }]
  assert.deepEqual(eventCapacity(rows), { people: 100, teams: 0 })
  assert.equal(capacityLabel(rows), '100 OSÓB')
})

// ---------------------------------------------------------------- teams (plan 5, task 6)

const team = (over = {}) => server({ kind: 'team', teamMin: 2, teamMax: 6, capacity: 20, name: 'Sztafeta', ...over })

test('T-50 a team competition keeps its kind and size through a save: a kind-less item would flip it back', () => {
  const r = competitionRow(team())
  assert.deepEqual([r.kind, r.teamMin, r.teamMax], ['team', '2', '6'])
  const { value, rows } = competitionsSection([r], { pricingMode: 'free', state: 'draft' })
  assert.deepEqual([value.items[0].kind, value.items[0].teamMin, value.items[0].teamMax], ['team', 2, 6])
  assert.equal(rows[0].saved.kind, 'team')
  // a server row with no kind and a new row are individual
  assert.equal(competitionRow(server({ kind: undefined })).kind, 'individual')
  assert.deepEqual([newCompetitionRow().kind, newCompetitionRow().teamMin, newCompetitionRow().teamMax], ['individual', '', ''])
})

test('T-50 a team row needs its size; a saved one mid-edit still sends its last whole value', () => {
  const fresh = { ...newCompetitionRow(), name: 'Sztafeta', capacity: '20', kind: 'team' }
  const s = competitionsSection([fresh], { pricingMode: 'free', state: 'draft' })
  assert.equal(s.value.items.length, 0)
  assert.ok(s.rowErrors[fresh.key].teamMin)

  const saved = competitionRow(team())
  const edit = competitionsSection([{ ...saved, teamMax: '1' }], { pricingMode: 'free', state: 'draft' })
  assert.deepEqual([edit.value.items[0].kind, edit.value.items[0].teamMax], ['team', 6])
  assert.ok(edit.rowErrors[saved.key].teamMax)
})

test('T-50 a row switched back to individual sends no size', () => {
  const r = { ...competitionRow(team()), kind: 'individual' }
  const item = competitionsSection([r], { pricingMode: 'free', state: 'draft' }).value.items[0]
  assert.equal(item.kind, 'individual')
  assert.equal('teamMin' in item, false)
  assert.equal('teamMax' in item, false)
})

test('T-50 the event limit counts people and teams apart, hidden competitions in neither', () => {
  const rows = [competitionRow(server({ capacity: 200 })), competitionRow(team({ categoryId: ID2 })),
    competitionRow(team({ categoryId: ID2, capacity: 7, hiddenAt: 'x' }))]
  assert.deepEqual(eventCapacity(rows), { people: 200, teams: 20 })
  assert.equal(capacityLabel(rows), '200 OSÓB + 20 DRUŻYN')
  assert.equal(capacityLabel([rows[1]]), '20 DRUŻYN')
  assert.equal(capacityLabel([competitionRow(team({ capacity: 1 }))]), '1 DRUŻYNA')
  assert.equal(capacityLabel([competitionRow(team({ capacity: 3 }))]), '3 DRUŻYNY')
  assert.equal(capacityLabel([]), '0 OSÓB')
})

// P3-R15 re-review I3: kind, price and hiding lock on the server's inUse (confirmed entries or a
// live unpaid order), not on taken, which counts paid entries only.
test('inUse comes from the server; without it a row is in use only when it has confirmed entries', () => {
  assert.equal(competitionRow(server({ taken: 0, inUse: true })).inUse, true)
  assert.equal(competitionRow(server({ taken: 3, inUse: false })).inUse, false)
  assert.equal(competitionRow(server({ taken: 2 })).inUse, true)
  assert.equal(competitionRow(server({ taken: 0 })).inUse, false)
  assert.equal(newCompetitionRow().inUse, false)
})

test('capacityUnit: the word beside a team limit agrees with the number, and an unfinished number reads as many', () => {
  assert.deepEqual(['1', '2', '4', '5', '12', '22', '20'].map(capacityUnit), ['DRUŻYNA', 'DRUŻYNY', 'DRUŻYNY', 'DRUŻYN', 'DRUŻYN', 'DRUŻYNY', 'DRUŻYN'])
  assert.deepEqual(['', 'x', null, undefined].map(capacityUnit), ['DRUŻYN', 'DRUŻYN', 'DRUŻYN', 'DRUŻYN'])
})
