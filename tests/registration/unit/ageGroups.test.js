import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ageOn, generateAgeGroups, ageGroupLabel, kidsGroupFor, generateKidsGroups,
} from '../../../supabase/functions/_shared/registration/ageGroups.js'

test('W-01 step10 labels', () => {
  const g = generateAgeGroups({ mode: 'step10', from: 16, to: 60 })
  const want = ['16–29', '30–39', '40–49', '50–59', '60+']
  assert.deepEqual(g.filter((x) => x.gender === 'K').map((x) => x.label), want.map((l) => 'K' + l))
  assert.deepEqual(g.filter((x) => x.gender === 'M').map((x) => x.label), want.map((l) => 'M' + l))
  assert.equal(g.find((x) => x.label === 'K60+').maxAge, null)
  assert.equal(g.find((x) => x.label === 'K16–29').maxAge, 29)
})

test('W-01 step5 starts K16–24, K25–29', () => {
  const k = generateAgeGroups({ mode: 'step5', from: 16, to: 60 }).filter((x) => x.gender === 'K')
  assert.deepEqual(k.slice(0, 2).map((x) => x.label), ['K16–24', 'K25–29'])
  assert.equal(k.at(-1).label, 'K60+')
})

test('W-02 ageOn', () => {
  assert.equal(ageOn('1976-12-06', '2026-12-06', 'race_day'), 50)
  assert.equal(ageOn('1976-12-07', '2026-12-06', 'race_day'), 49)
  assert.equal(ageOn('1976-12-07', '2026-12-06', 'year_end'), 50)
  assert.equal(ageOn('2008-02-29', '2026-02-28', 'race_day'), 17)
  assert.equal(ageOn('2008-02-29', '2026-03-01', 'race_day'), 18)
})

test('W-02 ageGroupLabel', () => {
  const groups = generateAgeGroups({ mode: 'step10', from: 16, to: 60 })
  assert.equal(ageGroupLabel({ birthDate: '1976-01-01', gender: 'K', raceDate: '2026-12-06', reckoning: 'race_day', groups }), 'K50–59')
  assert.equal(ageGroupLabel({ birthDate: '1976-01-01', gender: 'M', raceDate: '2026-12-06', reckoning: 'race_day', groups: [] }), 'M open')
  assert.equal(ageGroupLabel({ birthDate: '1976-01-01', gender: 'K', raceDate: '2026-12-06', reckoning: 'race_day', groups: [] }), 'K open')
  // age 10 is below every group
  assert.equal(ageGroupLabel({ birthDate: '2016-01-01', gender: 'M', raceDate: '2026-12-06', reckoning: 'race_day', groups }), 'M open')
})

test('kids groups', () => {
  const g = generateKidsGroups({ mode: 'step2', fromYear: 2016, toYear: 2023 })
  assert.ok(g.length > 0)
  const hit = kidsGroupFor('2019-05-05', g)
  assert.ok(hit)
  assert.equal(kidsGroupFor('1990-01-01', g), null)
  const g1 = generateKidsGroups({ mode: 'step1', fromYear: 2020, toYear: 2022 })
  assert.equal(g1.length, 3)
})
