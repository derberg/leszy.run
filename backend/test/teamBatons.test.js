import { test } from 'node:test'
import assert from 'node:assert/strict'
import { batonRefusal, normalizeBatonEpc } from '../src/lib/teamBatons.js'

const base = { teamId: 'T', epc: 'ABC', members: [{ id: 'p1' }], participantEpcs: ['P1', 'P2'], otherBatons: [{ teamId: 'U', epc: 'U1' }] }

test('a free tag is accepted and stored upper case, trimmed', () => {
  assert.deepEqual(batonRefusal({ ...base, epc: ' abc ' }), null)
  assert.equal(normalizeBatonEpc(' abc '), 'ABC')
})

test('clearing the baton with null is allowed', () => {
  assert.equal(batonRefusal({ ...base, epc: null }), null)
})

test('an unknown team is 404', () => {
  assert.deepEqual(batonRefusal({ ...base, members: [] }), { status: 404, error: 'Nie ma takiej drużyny.' })
})

test('a runner tag is refused', () => {
  assert.deepEqual(batonRefusal({ ...base, epc: 'p1' }), { status: 422, error: 'Ten tag jest przypisany zawodnikowi.' })
})

test("another team's baton tag is refused, the team's own is not", () => {
  assert.deepEqual(batonRefusal({ ...base, epc: 'u1' }), { status: 422, error: 'Ten tag ma już pałka innej drużyny.' })
  assert.equal(batonRefusal({ ...base, epc: 'x', otherBatons: [{ teamId: 'T', epc: 'X' }] }), null)
})

test('epc must be null or a non-empty string', () => {
  for (const epc of ['', '   ', 5, undefined]) assert.equal(batonRefusal({ ...base, epc }).status, 400)
})
