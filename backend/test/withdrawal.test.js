import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withdrawalRefusal, statusAfterReturn, gunStartOnReturn } from '../src/lib/withdrawal.js'

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

test('a runner already marked DNF or DSQ is refused, so the decision is not lost', () => {
  assert.match(withdrawalRefusal([{ status: 'dsq', finishTime: null }]), /DSQ/)
  assert.match(withdrawalRefusal([{ status: 'dnf', finishTime: null }]), /DNF/)
  assert.equal(withdrawalRefusal([{ status: 'dns', finishTime: null }]), null)
})

test('a runner returning after the backfill ran gets gun time', () => {
  const gun = new Date('2026-10-17T10:00:00Z')
  const run = { status: 'active', startedAt: gun }
  const at = (s) => new Date(gun.getTime() + s * 1000)
  assert.deepEqual(gunStartOnReturn(run, { gunBackfillSeconds: 60 }, { startTime: null }, true, at(300)), gun)
  assert.equal(gunStartOnReturn(run, { gunBackfillSeconds: 60 }, { startTime: null }, true, at(30)), null, 'the timer will still handle them')
  assert.equal(gunStartOnReturn(run, { gunBackfillEnabled: false }, { startTime: null }, true, at(300)), null)
  assert.equal(gunStartOnReturn(run, {}, { startTime: null }, false, at(300)), null, 'no check-in, no gun time')
  assert.equal(gunStartOnReturn(run, {}, { startTime: gun }, true, at(300)), null)
  assert.equal(gunStartOnReturn({ ...run, status: 'finished' }, {}, { startTime: null }, true, at(300)), null)
})
