import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTagInventory } from '../src/parse.js'

// EPC hex AABBCC01 base64-encoded is 'qrvMAQ=='
const valid = JSON.stringify({
  eventType: 'tagInventory',
  tagInventoryEvent: { epc: 'qrvMAQ==', peakRssiCdbm: -4200, antennaPort: 1 },
})

test('parses tagInventory into hex EPC + rssi', () => {
  const r = parseTagInventory(Buffer.from(valid))
  assert.deepEqual(r, { epc: 'AABBCC01', rssiCdbm: -4200, antennaPort: 1 })
})

test('returns null for non-JSON', () => {
  assert.equal(parseTagInventory(Buffer.from('garbage')), null)
})

test('returns null for other event types', () => {
  assert.equal(parseTagInventory(Buffer.from(JSON.stringify({ eventType: 'heartbeat' }))), null)
})

test('returns null when epc missing', () => {
  const p = JSON.stringify({ eventType: 'tagInventory', tagInventoryEvent: { peakRssiCdbm: -4000 } })
  assert.equal(parseTagInventory(Buffer.from(p)), null)
})
