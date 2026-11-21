// Run: node --test frontend/src/lib/teamGroups.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamLabels, teamLabelText, teamMembersByTeam } from './teamGroups.js'

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
