import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Confirmer } from '../src/confirmer.js'

function setup(t) {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  const confirmed = []
  const c = new Confirmer({ goneWindowMs: 3000, onConfirm: (x) => confirmed.push(x) })
  t.after(() => c.stop())
  return { c, confirmed }
}

test('confirms at peak time after 3s silence', (t) => {
  const { c, confirmed } = setup(t)
  c.read({ epc: 'A1', rssiCdbm: -5000, at: 1000 })
  c.read({ epc: 'A1', rssiCdbm: -3000, at: 2000 })  // peak
  c.read({ epc: 'A1', rssiCdbm: -4500, at: 2500 })  // weaker, resets goneTimer only
  mock.timers.tick(2999)
  assert.equal(confirmed.length, 0)
  mock.timers.tick(1)
  assert.deepEqual(confirmed, [{ epc: 'A1', peakTime: 2000, peakRssi: -3000 }])
})

test('lingering tag (continuous reads) never confirms until silence', (t) => {
  const { c, confirmed } = setup(t)
  for (let i = 0; i < 10; i++) {
    c.read({ epc: 'B2', rssiCdbm: -4000, at: 1000 + i * 1000 })
    mock.timers.tick(1000)
  }
  assert.equal(confirmed.length, 0) // goneTimer kept resetting
  mock.timers.tick(3000)
  assert.equal(confirmed.length, 1)
})

test('one pass only: reads after confirmation are ignored', (t) => {
  const { c, confirmed } = setup(t)
  c.read({ epc: 'C3', rssiCdbm: -4000, at: 1000 })
  mock.timers.tick(3000)
  assert.equal(confirmed.length, 1)
  c.read({ epc: 'C3', rssiCdbm: -2000, at: 99000 })
  mock.timers.tick(10000)
  assert.equal(confirmed.length, 1)
})

test('seed() suppresses already-recorded EPCs (restart recovery)', (t) => {
  const { c, confirmed } = setup(t)
  c.seed(['D4'])
  c.read({ epc: 'D4', rssiCdbm: -4000, at: 1000 })
  mock.timers.tick(5000)
  assert.equal(confirmed.length, 0)
})

test('independent EPCs confirm independently', (t) => {
  const { c, confirmed } = setup(t)
  c.read({ epc: 'E5', rssiCdbm: -4000, at: 1000 })
  mock.timers.tick(1000)
  c.read({ epc: 'F6', rssiCdbm: -4100, at: 2000 })
  mock.timers.tick(2000) // E5 hits 3s silence
  assert.equal(confirmed.length, 1)
  assert.equal(confirmed[0].epc, 'E5')
  mock.timers.tick(1000) // F6 hits 3s
  assert.equal(confirmed.length, 2)
})
