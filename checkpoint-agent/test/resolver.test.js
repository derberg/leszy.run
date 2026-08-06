import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createResolver } from '../src/resolver.js'

const roster = [
  { bib_number: 101, rfid_epc: 'aabbcc01' },   // lowercase in DB must still match
  { bib_number: 102, rfid_epc: 'AABBCC02' },
]

test('resolves known EPC case-insensitively', () => {
  const r = createResolver(roster)
  assert.equal(r.resolve('AABBCC01'), 101)
  assert.equal(r.resolve('AABBCC02'), 102)
  assert.equal(r.knownCount, 2)
})

test('unknown EPC returns null and is tracked once with last-seen update', () => {
  const r = createResolver(roster)
  assert.equal(r.resolve('DEADBEEF'), null)
  assert.equal(r.resolve('DEADBEEF'), null)
  const u = r.unknownList()
  assert.equal(u.length, 1)
  assert.equal(u[0].epc, 'DEADBEEF')
  assert.ok(u[0].lastSeenAt)
})

test('resolves lowercase query case-insensitively', () => {
  const r = createResolver(roster)
  assert.equal(r.resolve('aabbcc01'), 101)
  assert.equal(r.resolve('aabbcc02'), 102)
})

test('lookup returns bib for known EPC, null for unknown, case-insensitively, and does NOT track unknowns', () => {
  const r = createResolver(roster)
  assert.equal(r.lookup('AABBCC01'), 101)
  assert.equal(r.lookup('aabbcc02'), 102)
  assert.equal(r.lookup('DEADBEEF'), null)
  assert.equal(r.lookup('DEADBEEF'), null)
  // Unlike resolve(), lookup() must leave unknownList()/knownCount untouched.
  assert.deepEqual(r.unknownList(), [])
  assert.equal(r.knownCount, 2)
})
