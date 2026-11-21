import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamEditRefusal } from '../src/lib/teamEdit.js'

const T = '11111111-2222-3333-4444-555555555555'

test('a PATCH without team fields is never refused', () => {
  assert.equal(teamEditRefusal({ club: 'X' }, 3), null)
})

test('before the gun a team id, a leg or clearing them is allowed', () => {
  assert.equal(teamEditRefusal({ teamId: T }, 0), null)
  assert.equal(teamEditRefusal({ teamId: null, teamLeg: null }, 0), null)
  assert.equal(teamEditRefusal({ teamLeg: 2 }, 0), null)
})

test('a malformed team id or leg is 400', () => {
  assert.equal(teamEditRefusal({ teamId: 'abc' }, 0).status, 400)
  assert.equal(teamEditRefusal({ teamLeg: 0 }, 0).status, 400)
  assert.equal(teamEditRefusal({ teamLeg: '2' }, 0).status, 400)
})

test('once the runner has a live result the team is locked (409)', () => {
  assert.deepEqual(teamEditRefusal({ teamId: T }, 1), { status: 409, error: 'Bieg już wystartował. Drużynę zmienia się przed startem.' })
})
