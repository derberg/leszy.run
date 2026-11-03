// requiredConsents: which event consents a registration shows and requires. A minors-only
// consent (the guardian's „Zgoda opiekuna · dzieci”) applies only when a child is entered.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasMinor, requiredConsents } from '../../../supabase/functions/_shared/registration/consents.js'

const regulamin = { id: 'r', kind: 'regulamin', text: 'Regulamin' }
const custom = { id: 'c', kind: 'custom', text: 'Na własną odpowiedzialność.' }
const guardian = { id: 'g', kind: 'custom', text: 'Jako opiekun…', minorsOnly: true }

test('without a child a minors-only consent is left out', () => {
  assert.deepEqual(requiredConsents([regulamin, custom, guardian], { hasMinor: false }).map((c) => c.id), ['r', 'c'])
  assert.deepEqual(requiredConsents([regulamin, guardian]).map((c) => c.id), ['r'], 'no child is the default')
})

test('with a child every consent applies', () => {
  assert.deepEqual(requiredConsents([regulamin, custom, guardian], { hasMinor: true }).map((c) => c.id), ['r', 'c', 'g'])
})

test('a database row (minors_only) reads the same as the wire shape (minorsOnly)', () => {
  const row = { id: 'g', minors_only: true }
  assert.deepEqual(requiredConsents([row], { hasMinor: false }), [])
  assert.deepEqual(requiredConsents([row], { hasMinor: true }), [row])
  assert.deepEqual(requiredConsents([{ id: 'x', minors_only: false }]).map((c) => c.id), ['x'])
})

test('a missing list is empty', () => {
  assert.deepEqual(requiredConsents(undefined), [])
  assert.deepEqual(requiredConsents(null, { hasMinor: true }), [])
})

test('hasMinor: a person with role minor', () => {
  assert.equal(hasMinor([{ role: 'self' }, { role: 'adult' }]), false)
  assert.equal(hasMinor([{ role: 'self' }, { role: 'minor' }]), true)
  assert.equal(hasMinor([]), false)
  assert.equal(hasMinor(undefined), false)
})

test('hasMinor: a child whose guardian is somebody else (a team member\'s parent) is not the registrant\'s to consent for', () => {
  assert.equal(hasMinor([{ role: 'self' }, { role: 'minor', guardian: { name: 'Marta Leśna', email: 'm@x.pl' } }]), false)
  assert.equal(hasMinor([{ role: 'self' }, { role: 'minor', guardian: { name: 'M', email: 'm@x.pl' } }, { role: 'minor' }]), true)
})
