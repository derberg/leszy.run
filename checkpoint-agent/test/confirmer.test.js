import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Confirmer } from '../src/confirmer.js'

function setup(t) {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  const confirmed = []
  const c = new Confirmer({ quietMs: 2000, maxPassMs: 6000, onConfirm: (x) => confirmed.push(x) })
  t.after(() => c.stop())
  return { c, confirmed }
}

test('confirms at the peak, 2 s after the last stronger read', (t) => {
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

test('the pass stays open while the signal is still rising (2026-10-15, bib 4)', (t) => {
  // Bib 4 was first heard 4.5 s before its peak. A fixed 3 s window from the
  // first read closed while the runner was still walking in.
  const { c, confirmed } = setup(t)
  const reads = [[0, -7850], [1436, -7550], [1791, -7300], [2481, -7000], [2942, -6450],
    [3285, -6150], [3699, -5500], [4031, -5350], [4268, -4800], [4406, -3800], [4518, -3300]]
  let last = 0
  for (const [dt, rssi] of reads) {
    mock.timers.tick(dt - last)
    last = dt
    c.read({ epc: 'B4', rssiCdbm: rssi, at: 12009 + dt })
  }
  // The peak came 4.5 s in, so the 6 s cap (1.482 s later) closes the pass
  // before the 2 s quiet window would.
  mock.timers.tick(1481)
  assert.equal(confirmed.length, 0)
  mock.timers.tick(1)
  assert.deepEqual(confirmed, [{ epc: 'B4', peakTime: 16527, peakRssi: -3300 }])
})

test('a tag that keeps getting stronger is confirmed 6 s after its first read', (t) => {
  const { c, confirmed } = setup(t)
  c.read({ epc: 'B2', rssiCdbm: -4000, at: 1000 })
  for (let i = 1; i <= 16; i++) {
    mock.timers.tick(500)
    // A runner standing at the aid station keeps being read, more strongly too.
    c.read({ epc: 'B2', rssiCdbm: -4000 + i * 100, at: 1000 + i * 500 })
  }
  assert.equal(confirmed.length, 1, 'closed at 6 s, not held open by the reads')
  assert.equal(confirmed[0].peakTime, 6500, 'only reads inside the 6 s compete for the peak')
})

test('one pass only: reads after confirmation are ignored', (t) => {
  const { c, confirmed } = setup(t)
  c.read({ epc: 'C3', rssiCdbm: -4000, at: 1000 })
  mock.timers.tick(2000)
  assert.equal(confirmed.length, 1)
  c.read({ epc: 'C3', rssiCdbm: -2000, at: 99000 })
  mock.timers.tick(10000)
  assert.equal(confirmed.length, 1)
})

test('seed() suppresses already-recorded EPCs (restart recovery)', (t) => {
  const { c, confirmed } = setup(t)
  c.seed(['D4'])
  c.read({ epc: 'D4', rssiCdbm: -4000, at: 1000 })
  mock.timers.tick(7000)
  assert.equal(confirmed.length, 0)
})

test('independent EPCs confirm independently', (t) => {
  const { c, confirmed } = setup(t)
  c.read({ epc: 'E5', rssiCdbm: -4000, at: 1000 })
  mock.timers.tick(1000)
  c.read({ epc: 'F6', rssiCdbm: -4100, at: 2000 })
  mock.timers.tick(1000) // E5's quiet window ends
  assert.equal(confirmed.length, 1)
  assert.equal(confirmed[0].epc, 'E5')
  mock.timers.tick(1000) // F6's quiet window ends
  assert.equal(confirmed.length, 2)
})

test('seed() clears armed timer for in-range EPC (no confirm after)', (t) => {
  const { c, confirmed } = setup(t)
  c.read({ epc: 'X1', rssiCdbm: -4000, at: 1000 })
  mock.timers.tick(1000)
  c.seed(['X1'])
  mock.timers.tick(7000) // advance well past the pass
  assert.equal(confirmed.length, 0) // no confirm fired
})
