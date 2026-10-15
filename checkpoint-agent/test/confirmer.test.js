import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Confirmer } from '../src/confirmer.js'

function setup(t) {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  const confirmed = []
  const c = new Confirmer({ passWindowMs: 3000, onConfirm: (x) => confirmed.push(x) })
  t.after(() => c.stop())
  return { c, confirmed }
}

test('confirms at peak time 3 s after the first read', (t) => {
  const { c, confirmed } = setup(t)
  c.read({ epc: 'A1', rssiCdbm: -5000, at: 1000 })
  mock.timers.tick(1000)
  c.read({ epc: 'A1', rssiCdbm: -3000, at: 2000 })  // peak
  mock.timers.tick(500)
  c.read({ epc: 'A1', rssiCdbm: -4500, at: 2500 })  // weaker, does not extend the pass
  mock.timers.tick(1499)
  assert.equal(confirmed.length, 0)
  mock.timers.tick(1)
  assert.deepEqual(confirmed, [{ epc: 'A1', peakTime: 2000, peakRssi: -3000 }])
})

test('a tag that stays in range is confirmed 3 s after its first read', (t) => {
  const { c, confirmed } = setup(t)
  c.read({ epc: 'B2', rssiCdbm: -4000, at: 1000 })
  for (let i = 1; i <= 10; i++) {
    mock.timers.tick(500)
    // A runner standing at the aid station keeps being read, more strongly too.
    c.read({ epc: 'B2', rssiCdbm: -4000 + i * 100, at: 1000 + i * 500 })
  }
  assert.equal(confirmed.length, 1, 'closed at 3 s, not held open by the reads')
  assert.equal(confirmed[0].peakTime, 3500, 'only reads inside the window compete for the peak')
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
  mock.timers.tick(2000) // E5's window ends
  assert.equal(confirmed.length, 1)
  assert.equal(confirmed[0].epc, 'E5')
  mock.timers.tick(1000) // F6's window ends
  assert.equal(confirmed.length, 2)
})

test('seed() clears armed timer for in-range EPC (no confirm after)', (t) => {
  const { c, confirmed } = setup(t)
  c.read({ epc: 'X1', rssiCdbm: -4000, at: 1000 })
  mock.timers.tick(1000)
  c.seed(['X1'])
  mock.timers.tick(5000) // advance well past the window
  assert.equal(confirmed.length, 0) // no confirm fired
})
