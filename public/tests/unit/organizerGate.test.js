import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextOrganizerStep, organizerFeaturesShown } from '../../src/lib/organizerGate.js'

test('a plain member gets no step, whatever the club state', () => {
  for (const enabled of [true, false]) {
    for (const agreementAccepted of [true, false]) {
      assert.equal(nextOrganizerStep({ enabled, waitlisted: false, agreementAccepted, role: 'member' }), null)
    }
  }
})

test('a club without registration goes to the waitlist, joined or not', () => {
  for (const role of ['owner', 'admin']) {
    assert.equal(nextOrganizerStep({ enabled: false, waitlisted: false, agreementAccepted: false, role }), 'waitlist')
    assert.equal(nextOrganizerStep({ enabled: false, waitlisted: true, agreementAccepted: true, role }), 'waitlist')
  }
})

test('an enabled club without the current agreement goes to the agreement', () => {
  for (const role of ['owner', 'admin']) {
    assert.equal(nextOrganizerStep({ enabled: true, waitlisted: false, agreementAccepted: false, role }), 'agreement')
  }
})

test('an enabled club with the agreement accepted goes to the wizard', () => {
  for (const role of ['owner', 'admin']) {
    assert.equal(nextOrganizerStep({ enabled: true, waitlisted: true, agreementAccepted: true, role }), 'wizard')
  }
})

test('payout and agreement are shown only when organizer-status says enabled: true', () => {
  assert.equal(organizerFeaturesShown({ enabled: true, role: 'owner' }), true)
  assert.equal(organizerFeaturesShown({ enabled: false, waitlisted: true, role: 'owner' }), false)
  assert.equal(organizerFeaturesShown({ enabled: false, waitlisted: false, role: 'admin' }), false)
  assert.equal(organizerFeaturesShown(null), false)
  assert.equal(organizerFeaturesShown(undefined), false)
})
