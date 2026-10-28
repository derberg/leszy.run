import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRemoved, seedStatus, isRegistrationEvent, startListFor } from '../src/lib/registrationGuards.js'

test('isRemoved follows removedAt', () => {
  assert.equal(isRemoved({ removedAt: new Date() }), true)
  assert.equal(isRemoved({ removedAt: null }), false)
  assert.equal(isRemoved({}), false)
})

test('seedStatus', () => {
  assert.equal(seedStatus({ removedAt: new Date(), checkin: {} }), null)
  assert.equal(seedStatus({ removedAt: new Date(), withdrawnAt: new Date() }), null)
  assert.equal(seedStatus({ withdrawnAt: new Date(), checkin: {} }), 'dns')
  assert.equal(seedStatus({ checkin: {} }), 'checked_in')
  assert.equal(seedStatus({}), 'registered')
  assert.equal(seedStatus({ deletedAt: new Date() }), 'registered')
})

test('isRegistrationEvent follows clubId', () => {
  assert.equal(isRegistrationEvent({ clubId: 'c' }), true)
  assert.equal(isRegistrationEvent({ clubId: null }), false)
  assert.equal(isRegistrationEvent(undefined), false)
})

test('removed participants are excluded from the start list', () => {
  const list = startListFor([{ id: 1 }, { id: 2, removedAt: new Date() }, { id: 3, withdrawnAt: new Date() }])
  assert.deepEqual(list.map((p) => p.id), [1, 3])
})
