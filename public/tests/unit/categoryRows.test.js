import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ageTemplateFrom, ageModeOf, ageGroupsValue, kidsRowsFor, kidsModeOf, kidsGroupsValue, countLabel,
  categoriesSection, ageIdsFrom, reconcileRowIds, kidsRow, settleKids,
} from '../../src/lib/categoryRows.js'

const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'
const KIDS = '33333333-3333-4333-8333-333333333333'
const G1 = '44444444-4444-4444-8444-444444444444'

const stored = (categoryId, gender, label, minAge, maxAge, id) => ({ id, categoryId, gender, label, minAge, maxAge })

test('the template is the groups of one competition, K before M, youngest first', () => {
  const t = ageTemplateFrom([
    stored(C1, 'M', 'M16–39', 16, 39), stored(C1, 'K', 'K40+', 40, null), stored(C1, 'K', 'K16–39', 16, 39),
    stored(C2, 'K', 'K16–39', 16, 39),
  ])
  assert.deepEqual(t.map((g) => g.label), ['K16–39', 'K40+', 'M16–39'])
})

test('the mode is read back from the stored groups', () => {
  const ten = [
    { gender: 'K', label: 'K16–29', minAge: 16, maxAge: 29 }, { gender: 'K', label: 'K30–39', minAge: 30, maxAge: 39 },
    { gender: 'K', label: 'K40+', minAge: 40, maxAge: null },
    { gender: 'M', label: 'M16–29', minAge: 16, maxAge: 29 }, { gender: 'M', label: 'M30–39', minAge: 30, maxAge: 39 },
    { gender: 'M', label: 'M40+', minAge: 40, maxAge: null },
  ]
  assert.deepEqual(ageModeOf(ten), { mode: 'step10', from: 16, to: 40 })
  assert.equal(ageModeOf(ten.filter((g) => g.label !== 'K30–39')).mode, 'custom')
  assert.equal(ageModeOf([]), null)
})

test('age groups go to every visible adult competition, keeping known ids', () => {
  const template = [{ gender: 'K', label: 'K16+', minAge: 16, maxAge: null }]
  const comps = [
    { categoryId: C1, isKids: false, hidden: false }, { categoryId: C2, isKids: false, hidden: true },
    { categoryId: KIDS, isKids: true, hidden: false }, { categoryId: null, isKids: false, hidden: false },
  ]
  const ids = new Map([[`${C1}|K|K16+`, G1]])
  assert.deepEqual(ageGroupsValue(template, comps, ids), [
    { id: G1, categoryId: C1, gender: 'K', label: 'K16+', minAge: 16, maxAge: null },
  ])
})

test('kids rows come from the competition\'s ages and the race year, two years or one per group', () => {
  const comp = { categoryId: KIDS, minAge: 4, maxAge: 9 }
  const two = kidsRowsFor(comp, '2026-12-06', 'step2')
  assert.deepEqual(two.map((r) => [r.label, r.birthYearFrom, r.birthYearTo]), [
    ['2017–2018', 2017, 2018], ['2019–2020', 2019, 2020], ['2021–2022', 2021, 2022],
  ])
  assert.equal(kidsRowsFor(comp, '2026-12-06', 'step1').length, 6)
  assert.equal(kidsModeOf(two), 'step2')
  assert.equal(kidsModeOf([{ ...two[0], birthYearTo: 2017 }, ...two.slice(1)]), 'custom')
})

test('kids groups value: whole rows only, gender null for „razem”, blank distance null', () => {
  const rows = [
    { key: 1, id: null, label: 'Maluchy', birthYearFrom: 2021, birthYearTo: 2023, gender: null, distanceLabel: '' },
    { key: 2, id: G1, label: 'Dzieci', birthYearFrom: 2017, birthYearTo: 2018, gender: 'K', distanceLabel: '400 m' },
    { key: 3, id: null, label: '', birthYearFrom: 2015, birthYearTo: 2016, gender: null, distanceLabel: '' },
  ]
  const { items, sentKeys } = kidsGroupsValue(KIDS, rows)
  assert.deepEqual(items, [
    { categoryId: KIDS, label: 'Maluchy', birthYearFrom: 2021, birthYearTo: 2023, gender: null, distanceLabel: null },
    { id: G1, categoryId: KIDS, label: 'Dzieci', birthYearFrom: 2017, birthYearTo: 2018, gender: 'K', distanceLabel: '400 m' },
  ])
  assert.deepEqual(sentKeys, [1, 2])
})

test('Polish counts', () => {
  assert.equal(countLabel(1, ['KONKURENCJA', 'KONKURENCJE', 'KONKURENCJI']), '1 KONKURENCJA')
  assert.equal(countLabel(4, ['KONKURENCJA', 'KONKURENCJE', 'KONKURENCJI']), '4 KONKURENCJE')
  assert.equal(countLabel(12, ['KONKURENCJA', 'KONKURENCJE', 'KONKURENCJI']), '12 KONKURENCJI')
  assert.equal(countLabel(22, ['KONKURENCJA', 'KONKURENCJE', 'KONKURENCJI']), '22 KONKURENCJE')
  assert.equal(countLabel(40, ['KLASYFIKACJA', 'KLASYFIKACJE', 'KLASYFIKACJI']), '40 KLASYFIKACJI')
})

const G2 = '55555555-5555-4555-8555-555555555555'
const G3 = '66666666-6666-4666-8666-666666666666'

test('I4: a hidden competition keeps its stored age and kids groups, unchanged and with their ids', () => {
  const template = [{ gender: 'K', label: 'K16+', minAge: 16, maxAge: null }]
  const competitions = [
    { categoryId: C1, isKids: false, hidden: false }, { categoryId: C2, isKids: false, hidden: true },
    { categoryId: KIDS, isKids: true, hidden: true },
  ]
  const stored = {
    ageGroups: [stored0(C2, 'M', 'M18–39', 18, 39, G2)],
    kidsGroups: [{ id: G3, categoryId: KIDS, label: 'Maluchy', birthYearFrom: 2021, birthYearTo: 2022, gender: null, distanceLabel: null }],
  }
  const s = categoriesSection({ reckoning: 'race_day', template, competitions, kids: {}, stored, idOf: new Map() })
  assert.deepEqual(s.value.ageGroups, [
    { categoryId: C1, gender: 'K', label: 'K16+', minAge: 16, maxAge: null },
    { id: G2, categoryId: C2, gender: 'M', label: 'M18–39', minAge: 18, maxAge: 39 },
  ])
  assert.deepEqual(s.value.kidsGroups, [
    { id: G3, categoryId: KIDS, label: 'Maluchy', birthYearFrom: 2021, birthYearTo: 2022, gender: null, distanceLabel: null },
  ])
  assert.deepEqual(s.ageKeys, [`${C1}|K|K16+`, `${C2}|M|M18–39`])
})
function stored0(categoryId, gender, label, minAge, maxAge, id) { return { id, categoryId, gender, label, minAge, maxAge } }

test('I2: building the section is pure (the caller sets what was sent, only when the save starts)', () => {
  const kids = { [KIDS]: [kidsRow({ label: 'A', birthYearFrom: 2020, birthYearTo: 2021 })] }
  const input = { reckoning: 'race_day', template: [], competitions: [{ categoryId: KIDS, isKids: true, hidden: false }], kids, stored: {}, idOf: new Map() }
  const before = JSON.stringify(input.kids)
  const a = categoriesSection(input)
  const b = categoriesSection(input)
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(input.kids), before)
})

test('I1: ids come only from the latest answer; a group the server deleted loses its id', () => {
  // Co 10 lat saved (ids X), then Co 5 lat saved: K16–29 is gone from the answer.
  let idOf = ageIdsFrom([`${C1}|K|K16–29`], [G1])
  idOf = ageIdsFrom([`${C1}|K|K16–20`], [G2])
  assert.equal(idOf.get(`${C1}|K|K16–29`), undefined)
  assert.equal(idOf.get(`${C1}|K|K16–20`), G2)
  // A staged save (published) answers no ids: nothing changes.
  const rows = [{ key: 1, id: G1 }, { key: 2, id: G2 }]
  assert.equal(reconcileRowIds(rows, [1], undefined), rows)
  assert.deepEqual(reconcileRowIds(rows, [2], [G3]).map((r) => r.id), [null, G3])
})

test('I1: a saved kids group being retyped sends its last whole value, so nothing is deleted', () => {
  const [row] = settleKids([kidsRow({ id: G1, label: 'Maluchy', birthYearFrom: 2021, birthYearTo: 2022, gender: null, distanceLabel: '' })])
  const { items, sentKeys } = kidsGroupsValue(KIDS, [{ ...row, label: '' }])
  assert.deepEqual(items, [{ id: G1, categoryId: KIDS, label: 'Maluchy', birthYearFrom: 2021, birthYearTo: 2022, gender: null, distanceLabel: null }])
  assert.deepEqual(sentKeys, [row.key])
})
