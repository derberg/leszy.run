import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseRegister, parseRegisterDistance, isValidCertificate } from '../src/lib/atestRegister.js'
import { matchEvent, distanceKm, nameScore, sameTown, sameAtest } from '../src/lib/atestMatch.js'

// A real excerpt of http://www.taddziek.pl/rejestr_tras_atestowanych.html,
// fetched 2026-11-07 and re-encoded as UTF-8.
const register = parseRegister(readFileSync(new URL('./fixtures/taddziek-register-excerpt.html', import.meta.url), 'utf-8'))

test('the register table parses into rows, the header row dropped', () => {
  assert.equal(register.length, 15)
  const pab = register.find((r) => r.town === 'Pabianice')
  assert.deepEqual(pab, {
    distance_km: 21.0975,
    town: 'Pabianice',
    name: 'PABIANICKI PÓŁMARATON "WSZYSTKO GRA"',
    certified_on: '2025-04-06',
    status: null,
  })
  // "21,0975km" without a space and "1,23564" without a unit are both distances.
  assert.equal(parseRegisterDistance('21,0975km'), 21.0975)
  assert.equal(parseRegisterDistance('1,23564'), 1.23564)
  assert.equal(parseRegisterDistance('Dystans'), null)
})

test('a status of any kind, or five years past, voids the certificate', () => {
  const runWarsaw = register.find((r) => r.name === 'RUN WARSAW')
  assert.equal(runWarsaw.status, 'nie rozgrywa się')
  assert.equal(isValidCertificate(runWarsaw, '2026-11-20'), false)
  const row = { status: null, certified_on: '2021-11-25' }
  assert.equal(isValidCertificate(row, '2026-11-24'), true)
  assert.equal(isValidCertificate(row, '2026-11-25'), false)
  // A whitespace-only cell is no status.
  assert.equal(register.find((r) => r.town === 'Nieporęt').status, null)
})

test('distances parse the way calendar rows write them', () => {
  assert.equal(distanceKm('21.1 km'), 21.1)
  assert.equal(distanceKm('Półmaraton'), 21.0975)
  assert.equal(distanceKm('Maraton'), 42.195)
  assert.equal(distanceKm('21 km'), 21.0975)
  assert.equal(distanceKm('500 m'), 0.5)
  assert.equal(distanceKm('6h'), null)
})

test('a register town "X k. Y" is town X', () => {
  assert.equal(sameTown('Luboń', 'Luboń k. Poznania'), true)
  assert.equal(sameTown('Goleniów, Polska', 'Goleniów'), true)
  assert.equal(sameTown('Gdynia', 'Gdańsk'), false)
})

test('the town counts for nothing: "Szczeciński Bieg Niepodległości" is not SZCZECIŃSKI BIEG NOCNY', () => {
  const r = matchEvent({ name: 'Szczeciński Bieg Niepodległości', location: 'Szczecin', date: '2026-11-11', distances: '10 km' }, register)
  assert.deepEqual(r, { atest: [], review: [] })
})

test('a strict match is published from the register alone', () => {
  const r = matchEvent({ name: 'XIV Pabianicki Półmaraton WSZYSTKO GRA', location: 'Pabianice', date: '2027-03-21', distances: '5 km, 21.1 km' }, register)
  assert.deepEqual(r.atest, [{ km: 21.0975, certified_on: '2025-04-06', source: 'register' }])
  assert.deepEqual(r.review, [])
})

test('both names carrying the town make a generic word specific', () => {
  assert.equal(nameScore('Krakowski Bieg Niepodległości', 'KRAKOWSKI BIEG NIEPODLEGŁOŚCI', 'Kraków').distinctive, true)
  // One name without the town proves nothing: every town runs one on 11 November.
  assert.equal(nameScore('Gdyński Bieg Niepodległości', 'BIEG NIEPODLEGŁOŚCI', 'Gdynia').distinctive, false)
})

test('a generic-only match goes to review, not to the page', () => {
  const r = matchEvent({ name: 'Gdyński Bieg Niepodległości', location: 'Gdynia', date: '2026-11-11', distances: '10 km' }, register)
  assert.deepEqual(r.atest, [])
  assert.equal(r.review.length, 1)
  assert.equal(r.review[0].reason, 'near_miss')
  assert.equal(r.review[0].register_name, 'BIEG NIEPODLEGŁOŚCI')
})

test('a regulamin claim lifts a loose match to "both"', () => {
  const r = matchEvent({
    name: 'Gdyński Bieg Niepodległości', location: 'Gdynia', date: '2026-11-11', distances: '10 km',
    atest_claim: { certified: true, distances_km: [10] },
  }, register)
  assert.deepEqual(r.atest, [{ km: 10, certified_on: '2024-02-04', source: 'both' }])
})

test('a regulamin that denies the atest wins over the register', () => {
  const r = matchEvent({
    name: 'Pabianicki Półmaraton', location: 'Pabianice', date: '2027-03-21', distances: '21.1 km',
    atest_claim: { certified: false, distances_km: [] },
  }, register)
  assert.deepEqual(r.atest, [])
  assert.equal(r.review[0].reason, 'regulamin_denies')
})

test('a claim the register cannot back, or backs only with an expired row, is reviewed', () => {
  const none = matchEvent({ name: 'Bieg Leśny', location: 'Pabianice', date: '2027-03-21', distances: '10 km', atest_claim: { certified: true } }, register)
  assert.deepEqual(none, { atest: [], review: [{ reason: 'claim_unconfirmed', km: 10 }] })
  const expired = matchEvent({ name: 'Run Warsaw', location: 'Warszawa', date: '2027-03-21', distances: '5 km', atest_claim: { certified: true } }, register)
  assert.deepEqual(expired.atest, [])
  assert.equal(expired.review[0].reason, 'claim_expired')
})

test('a claim naming other distances does not cover this one', () => {
  const r = matchEvent({
    name: 'Bieg Leśny', location: 'Pabianice', date: '2027-03-21', distances: '5 km, 10 km',
    atest_claim: { certified: true, distances_km: [10] },
  }, register)
  assert.deepEqual(r.review, [{ reason: 'claim_unconfirmed', km: 10 }])
})

test('sameAtest ignores order', () => {
  const a = [{ km: 5, certified_on: '2024-01-01', source: 'register' }, { km: 10, certified_on: '2024-01-01', source: 'both' }]
  assert.equal(sameAtest(a, [...a].reverse()), true)
  assert.equal(sameAtest(a, a.slice(0, 1)), false)
  assert.equal(sameAtest(null, []), true)
})

test('a regulamin atest answer needs the document to mention certification', async () => {
  const { dropUnsupportedFields } = await import('../src/lib/extractionEvidence.js')
  const guessed = { atest: { certified: true, distances_km: [] } }
  assert.deepEqual(dropUnsupportedFields(guessed, 'Bieg na 10 km ulicami miasta. Opłata startowa 50 zł.'), ['atest'])
  assert.equal(guessed.atest, undefined)
  const stated = { atest: { certified: true, distances_km: [10] } }
  assert.deepEqual(dropUnsupportedFields(stated, 'Trasa posiada atest PZLA. Opłata startowa 50 zł.'), [])
  assert.deepEqual(stated.atest, { certified: true, distances_km: [10] })
})
