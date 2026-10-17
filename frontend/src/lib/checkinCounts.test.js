// Run: node --test frontend/src/lib/checkinCounts.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkinCounts } from './checkinCounts.js'

const at = (hms) => `2026-10-17T${hms}.000Z`

test('counts runners, QR self check-ins and admin confirmations separately', () => {
  const counts = checkinCounts([
    { checkin: null },                                                  // nothing yet
    { checkin: { createdAt: at('07:00:00'), checkedInAt: null } },      // QR, waiting at the desk
    { checkin: { createdAt: at('07:00:00'), checkedInAt: at('08:30:00') } }, // QR, then confirmed
    { checkin: { createdAt: at('08:40:00'), checkedInAt: at('08:40:00') } }, // admin only
  ])
  assert.deepEqual(counts, { total: 4, selfCheckins: 2, confirmed: 2 })
})

test('an admin check-in written a moment after the row is not counted as QR', () => {
  const counts = checkinCounts([
    { checkin: { createdAt: at('08:40:00'), checkedInAt: at('08:40:01') } },
  ])
  assert.equal(counts.selfCheckins, 0)
  assert.equal(counts.confirmed, 1)
})

test('an empty list counts zero', () => {
  assert.deepEqual(checkinCounts([]), { total: 0, selfCheckins: 0, confirmed: 0 })
})
