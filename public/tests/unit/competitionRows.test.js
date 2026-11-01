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

// ---------------------------------------------------------------- tiered (A3, A8)
import {
  addTier, assignTierIds, currentTierIndex, switchPricing, tierColumns, tierLabel, tierLocks,
} from '../../src/lib/competitionRows.js'

const T1 = '33333333-3333-4333-8333-333333333333'
const T2 = '44444444-4444-4444-8444-444444444444'
const T3 = '55555555-5555-4555-8555-555555555555'
const WINDOW = { opensAt: '2027-10-31T23:00:00.000Z', closesAt: '2027-12-01T23:00:00.000Z' } // 1.11–1.12 Warsaw

test('V-70 fixed → tiered: one dated column and the close; every cell starts at the fixed price', () => {
  const rows = [competitionRow(server({ priceGrosze: 6000 }))]
  const tiers = tierColumns([], 'fixed')
  assert.deepEqual(tiers.map((t) => [t.id, t.endsOn]), [[null, ''], [null, null]])
  const next = switchPricing(rows, tiers, 'tiered')
  assert.deepEqual(tiers.map((t) => next[0].prices[t.key]), ['60', '60'])
})

test('V-70 the A3 fixture: tiers new:<index> in column order, a price per column, the window judges the dates', () => {
  let tiers = addTier(tierColumns([], 'fixed'))
  tiers = tiers.map((t, i) => (i === 0 ? { ...t, endsOn: '2027-11-15' } : i === 1 ? { ...t, endsOn: '2027-11-25' } : t))
  const row = competitionRow(server())
  row.prices = Object.fromEntries(tiers.map((t, i) => [t.key, ['60', '70', '80'][i]]))
  const s = competitionsSection([row], { pricingMode: 'tiered', state: 'draft', tiers, ...WINDOW })
  assert.equal(s.ok, true)
  assert.equal(s.tierError, null)
  assert.deepEqual(s.value.tiers, [{ endsOn: '2027-11-15' }, { endsOn: '2027-11-25' }, { endsOn: null }])
  assert.deepEqual(s.value.items[0].prices, { 'new:0': '60', 'new:1': '70', 'new:2': '80' })
  assert.deepEqual(s.sentTierKeys, tiers.map((t) => t.key))

  const ids = assignTierIds(tiers, s.sentTierKeys, [T1, T2, T3])
  const again = competitionsSection(s.rows, { pricingMode: 'tiered', state: 'draft', tiers: ids, ...WINDOW })
  assert.deepEqual(again.value.items[0].prices, { [T1]: '60', [T2]: '70', [T3]: '80' })
  assert.deepEqual(again.value.tiers[0], { id: T1, endsOn: '2027-11-15' })

  const late = tiers.map((t, i) => (i === 1 ? { ...t, endsOn: '2027-12-01' } : t))
  const bad = competitionsSection([row], { pricingMode: 'tiered', state: 'draft', tiers: late, ...WINDOW })
  assert.equal(bad.ok, false)
  assert.equal(bad.tierError, 'Daty progów muszą rosnąć i kończyć się przed zamknięciem zapisów.')
  assert.deepEqual(bad.rowErrors, {})
  const blank = competitionsSection([row], { pricingMode: 'tiered', state: 'draft', tiers: addTier(tiers), ...WINDOW })
  assert.equal(blank.tierError, 'Podaj datę końca każdego progu.')
})

test('V-70 a row missing a tier price is not sent and is named', () => {
  const tiers = tierColumns([{ id: T1, endsOn: '2027-11-15' }, { id: T3, endsOn: null }], 'tiered')
  const row = { ...newCompetitionRow(), name: 'Bieg 3 km', capacity: '50', prices: { [T1]: '60' } }
  const s = competitionsSection([row], { pricingMode: 'tiered', state: 'draft', tiers, ...WINDOW })
  assert.equal(s.value.items.length, 0)
  assert.equal(s.rowErrors[row.key].prices, 'Podaj cenę w złotych, np. 60 albo 60,50.')
})

test('tiered → fixed: an empty fixed price takes today\'s tier price, the tier the server keeps', () => {
  const tiers = tierColumns([{ id: T1, endsOn: '2027-11-15' }, { id: T2, endsOn: '2027-11-25' }, { id: T3, endsOn: null }], 'tiered')
  const row = { ...competitionRow(server()), price: '', prices: { [T1]: '60', [T2]: '70', [T3]: '80' } }
  assert.equal(switchPricing([row], tiers, 'fixed', '2027-11-20')[0].price, '70')
  assert.equal(currentTierIndex(tiers, '2027-11-26'), 2)
  assert.equal(tierLabel('2027-11-05'), 'DO 5.11')
  assert.equal(tierLabel(''), 'DO')
})

test('V-71 A8: in use, the current and past columns are locked; a later column and an unused competition are not', () => {
  const tiers = tierColumns([{ id: T1, endsOn: '2027-11-15' }, { id: T2, endsOn: '2027-11-25' }, { id: T3, endsOn: null }], 'tiered')
  const used = { ...competitionRow(server({ inUse: true })) }
  const free = { ...competitionRow(server({ categoryId: ID2, inUse: false })) }
  const locks = tierLocks(tiers, [used, free], { published: true, today: '2027-11-10' })
  assert.deepEqual(tiers.map((t) => locks.date(t)), [true, false, false])
  assert.deepEqual(tiers.map((t) => locks.amount(t, used)), [true, false, false])
  assert.deepEqual(tiers.map((t) => locks.amount(t, free)), [false, false, false])
  assert.equal(locks.canAdd, true)
  // Past tier 1 and current tier 2 on 20.11; once the open-ended one is current nothing can be added.
  const later = tierLocks(tiers, [used], { published: true, today: '2027-11-20' })
  assert.deepEqual(tiers.map((t) => later.amount(t, used)), [true, true, false])
  assert.equal(tierLocks(tiers, [used], { published: true, today: '2027-11-30' }).canAdd, false)
  // A draft, or nobody registered: nothing is locked.
  const draft = tierLocks(tiers, [used], { published: false, today: '2027-11-20' })
  assert.deepEqual(tiers.map((t) => [draft.date(t), draft.amount(t, used)]), [[false, false], [false, false], [false, false]])
  // A column added after publish has no id: never locked.
  const added = addTier(tiers)
  assert.equal(tierLocks(added, [used], { published: true, today: '2027-11-10' }).date(added[2]), false)
})
