import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withdrawalRefusal } from '../src/lib/withdrawal.js'

test('before the race starts a runner may be withdrawn', () => {
  assert.equal(withdrawalRefusal(0), null)
})

test('once the race has started the status belongs to Przegląd trasy', () => {
  assert.match(withdrawalRefusal(1), /Przeglądzie trasy/)
})
