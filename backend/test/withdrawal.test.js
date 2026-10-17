import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withdrawalRefusal, statusAfterReturn } from '../src/lib/withdrawal.js'

test('a runner with no finish time may be withdrawn', () => {
  assert.equal(withdrawalRefusal([]), null)
  assert.equal(withdrawalRefusal([{ finishTime: null, gunDurationMs: null, durationMs: null }]), null)
})

test('a runner with a finish time is refused, with the time in the message', () => {
  const msg = withdrawalRefusal([{ finishTime: new Date(), gunDurationMs: 6_127_000, durationMs: 6_120_000 }])
  assert.match(msg, /\(1:42:07\)/)
  assert.match(msg, /Przeglądzie trasy/)
})

test('undoing a withdrawal restores the status the race would have given', () => {
  assert.equal(statusAfterReturn({ startTime: new Date() }, true), 'started')
  assert.equal(statusAfterReturn({ startTime: null }, true), 'checked_in')
  assert.equal(statusAfterReturn({ startTime: null }, false), 'registered')
})
