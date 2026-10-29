import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pollDelayMs, POLL_WINDOW_MS } from '../../src/lib/orderPolling.js'

// The order page polls order-status, which allows 120 reads per order and hour.
// A few quick reads right after the return from dpay, then backing off: never
// more than one read per 30 s on average, and the page stops on its own.

/** The read times (ms after the first read) the schedule produces. */
function schedule() {
  const at = [0]
  for (let n = 1; ; n++) {
    const d = pollDelayMs(n)
    if (d == null) return at
    at.push(at[at.length - 1] + d)
  }
}

describe('pollDelayMs', () => {
  it('reads quickly right after the return from dpay', () => {
    assert.equal(pollDelayMs(1), 3000)
    assert.ok(pollDelayMs(2) <= 10_000)
  })

  it('backs off and never shortens', () => {
    const at = schedule()
    for (let i = 2; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= at[i - 1] - (at[i - 2] ?? 0), `read ${i}`)
  })

  it('stays under one read per 30 s on average and under the 120 per hour throttle', () => {
    const at = schedule()
    assert.ok(at.length <= 120)
    const span = at[at.length - 1]
    assert.ok(span / (at.length - 1) >= 30_000, `average ${span / (at.length - 1)} ms`)
    // Any hour-long window holds fewer than 120 reads, even two page loads back to back.
    assert.ok(at.length * 2 < 120)
  })

  it('stops within the polling window', () => {
    const at = schedule()
    assert.ok(at[at.length - 1] <= POLL_WINDOW_MS)
    assert.equal(pollDelayMs(1000), null)
  })

  it('a 429 waits at least as long as the server asks', () => {
    assert.equal(pollDelayMs(1, { retryAfterSec: 120 }), 120_000)
    assert.equal(pollDelayMs(20, { retryAfterSec: 1 }) >= 60_000, true)
  })
})
