import { test } from 'node:test'
import assert from 'node:assert/strict'
import { legOrderChoices, legOrderToSend, teamCompetitions } from '../../src/lib/legOrder.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

const comps = [
  { categoryId: A, kind: 'team', legOrderEnabled: false },
  { categoryId: B, kind: 'team', legOrderEnabled: true },
  { categoryId: null, kind: 'team' },
  { categoryId: '33333333-3333-4333-8333-333333333333', kind: 'individual' },
]
const teams = teamCompetitions(comps)

test('team competitions only; one choice per saved one', () => {
  assert.equal(teams.length, 3)
  assert.deepEqual(legOrderChoices(teams), { [A]: false, [B]: true })
  assert.deepEqual(teamCompetitions(undefined), [])
})

test('published: nothing goes while the map equals the live one, a re-saved map would stage a change', () => {
  const sent = legOrderToSend({ state: 'published', teams, choices: legOrderChoices(teams), staged: false })
  assert.equal(sent, null)
})

test('published: one change sends the full map, because staging replaces it whole', () => {
  const sent = legOrderToSend({ state: 'published', teams, choices: { [A]: true, [B]: true }, staged: false })
  assert.deepEqual(sent, { [A]: true, [B]: true })
})

test('published: compared with the live value, not the staged one shown', () => {
  const shown = [{ categoryId: A, kind: 'team', legOrderEnabled: true, legOrderLive: false }]
  assert.deepEqual(legOrderToSend({ state: 'published', teams: shown, choices: { [A]: true }, staged: false }), { [A]: true })
  assert.equal(legOrderToSend({ state: 'published', teams: shown, choices: { [A]: false }, staged: false }), null)
})

test('published: a staged map is overwritten even when going back to the live one, or it would stay staged', () => {
  const sent = legOrderToSend({ state: 'published', teams, choices: legOrderChoices(teams), staged: true })
  assert.deepEqual(sent, { [A]: false, [B]: true })
})

test('draft: the map goes with every save, a draft writes straight to the tables', () => {
  assert.deepEqual(legOrderToSend({ state: 'draft', teams, choices: legOrderChoices(teams), staged: false }), { [A]: false, [B]: true })
})

test('no saved team competition: no key at all', () => {
  assert.equal(legOrderToSend({ state: 'draft', teams: [], choices: {}, staged: false }), null)
  assert.equal(legOrderToSend({ state: 'published', teams: [{ categoryId: null, kind: 'team' }], choices: {}, staged: true }), null)
})
