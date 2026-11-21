// Run: node --test frontend/src/lib/teamGroups.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamLabels, teamLabelText, teamMembersByTeam, teamOptions } from './teamGroups.js'

const p = (id, firstName, lastName, teamId, teamLeg = null) => ({ id, firstName, lastName, teamId, teamLeg })
const rows = [
  p('1', 'Anna', 'Zając', 't1'),
  p('2', 'Jan', 'Kowal', 't2', 2),
  p('3', 'Ewa', 'Nowak', 't2', 1),
  p('4', 'Ola', 'Solo', null),
  p('5', 'Piotr', 'Adamski', 't1'),
]

test('labels a team by its name, else by its members surnames (leg order first)', () => {
  const labels = teamLabels(rows, { t1: 'Renifery' })
  assert.equal(teamLabelText(labels.get('t1')), 'Renifery')
  assert.equal(labels.get('t1').size, 2)
  assert.equal(teamLabelText(labels.get('t2')), 'Nowak · Kowal')
  assert.equal(labels.has(undefined), false)
  assert.equal(teamLabelText(labels.get('none')), null)
})

test('lists team members only, grouped by team label, then leg, then name', () => {
  const labels = teamLabels(rows, { t1: 'Renifery' })
  assert.deepEqual(teamMembersByTeam(rows, labels).map(r => r.id), ['3', '2', '5', '1'])
})

test('team options are the teams of the same category, by label', () => {
  const rows2 = [...rows.map(r => ({ ...r, categoryId: 'relay' })), { ...p('6', 'Kuba', 'Inny', 't3'), categoryId: 'other' }]
  const labels = teamLabels(rows2, { t1: 'Renifery' })
  assert.deepEqual(teamOptions(rows2, labels, 'relay'), [
    { teamId: 't2', label: 'Nowak · Kowal', size: 2 },
    { teamId: 't1', label: 'Renifery', size: 2 },
  ])
  assert.deepEqual(teamOptions(rows2, labels, 'none'), [])
})

test('newTeamId makes a v4 UUID without crypto.randomUUID', async () => {
  const { newTeamId } = await import('./teamGroups.js')
  const id = newTeamId({ getRandomValues: (a) => a.fill(255) })
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(newTeamId(), newTeamId())
})

test('a moved runner takes the next free leg in a fixed relay, none otherwise', async () => {
  const { legAfterMove } = await import('./teamGroups.js')
  assert.equal(legAfterMove(rows, 't2', '1', true), 3)
  assert.equal(legAfterMove(rows, 't2', '2', true), 2)
  assert.equal(legAfterMove(rows, 'fresh', '1', true), 1)
  assert.equal(legAfterMove(rows, 't2', '1', false), null)
  assert.equal(legAfterMove(rows, null, '1', true), null)
})
