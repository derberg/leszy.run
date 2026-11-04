import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { warsawMonth, lastMonths, buildAdminStats } from '../src/lib/adminStats.js'

describe('warsawMonth', () => {
  it('buckets by the Warsaw calendar, not UTC', () => {
    // 23:30 UTC on 31 Oct is 00:30 on 1 Nov in Warsaw (CET)
    assert.equal(warsawMonth('2026-10-31T23:30:00Z'), '2026-11')
    assert.equal(warsawMonth('2026-10-31T22:30:00Z'), '2026-10')
  })
  it('returns null for a missing timestamp', () => {
    assert.equal(warsawMonth(null), null)
  })
})

describe('lastMonths', () => {
  it('lists the newest month first and crosses the year', () => {
    assert.deepEqual(lastMonths('2026-02', 3), ['2026-02', '2026-01', '2025-12'])
  })
})

describe('buildAdminStats', () => {
  const now = '2026-11-04T15:00:00Z'
  const raw = {
    profiles: [
      { created_at: '2026-11-03T16:00:00Z', username: null, deleted_at: null },
      { created_at: '2026-11-03T17:00:00Z', username: 'ania', deleted_at: null },
      { created_at: '2026-10-10T10:00:00Z', username: 'tomek', deleted_at: '2026-10-20T10:00:00Z' },
    ],
    clubs: [{ created_at: '2026-10-28T12:00:00Z' }],
    clubMembers: [
      { joined_at: '2026-10-28T12:00:00Z', status: 'active', role: 'owner' },
      { joined_at: '2026-11-04T15:00:00Z', status: 'active', role: 'member' },
      { joined_at: '2026-11-01T15:00:00Z', status: 'left', role: 'member' }, // a join that later left still joined in November
    ],
    favorites: [{ created_at: '2026-11-03T16:30:00Z' }, { created_at: '2026-09-01T10:00:00Z' }],
    registrationEvents: [{ published_at: '2026-11-03T13:00:00Z', state: 'published' }, { published_at: null, state: 'draft' }],
    registrations: [
      { created_at: '2026-11-03T16:00:00Z', status: 'confirmed' },
      { created_at: '2026-11-02T16:00:00Z', status: 'cancelled' },
    ],
    orders: [
      { id: 'o1', paid_at: '2026-11-03T16:05:00Z', total: 20000 },
      { id: 'o2', paid_at: '2026-11-03T19:05:00Z', total: 20000 },
      { id: 'o3', paid_at: null, total: 5000 },
      { id: 'o4', paid_at: '2026-10-02T17:00:00Z', total: 14500 }, // refunded in full in November
      { id: 'o5', paid_at: '2026-10-02T18:00:00Z', total: 6200 }, // 2000 refunded
    ],
    refunds: [
      { order_id: 'o4', amount: 14000, dpay_status: 'accepted', responded_at: '2026-11-01T10:00:00Z', created_at: '2026-11-01T09:59:00Z' },
      { order_id: 'o4', amount: 500, dpay_status: 'accepted', responded_at: null, created_at: '2026-11-01T10:05:00Z' },
      { order_id: 'o5', amount: 2000, dpay_status: 'accepted', responded_at: '2026-10-03T10:00:00Z', created_at: '2026-10-03T10:00:00Z' },
      { order_id: 'o2', amount: 20000, dpay_status: 'rejected', responded_at: '2026-11-04T10:00:00Z', created_at: '2026-11-04T10:00:00Z' },
    ],
  }
  const stats = buildAdminStats(raw, { now, months: 3 })

  it('counts each metric in the month it happened', () => {
    const nov = stats.months.find((m) => m.month === '2026-11')
    assert.deepEqual(nov, {
      month: '2026-11', users: 2, onboarded: 1, clubs: 0, clubJoins: 2, favorites: 1,
      registrationEvents: 1, registrations: 1, paidOrders: 2, paidAmount: 40000, refundAmount: 14500,
    })
    const oct = stats.months.find((m) => m.month === '2026-10')
    assert.equal(oct.users, 1)
    assert.equal(oct.clubs, 1)
    assert.equal(oct.clubJoins, 0, 'the owner founding the club is not a join')
  })

  it('counts payments net of accepted refunds, in the month they were paid', () => {
    const oct = stats.months.find((m) => m.month === '2026-10')
    assert.equal(oct.paidOrders, 1, 'an order refunded in full is not a paid order')
    assert.equal(oct.paidAmount, 4200)
  })

  it('shows accepted refunds separately, in the month they were made', () => {
    const [nov, oct] = stats.months
    assert.equal(nov.refundAmount, 14500, 'a rejected refund moved no money')
    assert.equal(oct.refundAmount, 2000)
  })

  it('returns exactly the requested months, newest first, zero-filled', () => {
    assert.deepEqual(stats.months.map((m) => m.month), ['2026-11', '2026-10', '2026-09'])
    assert.equal(stats.months[2].favorites, 1)
    assert.equal(stats.months[2].users, 0)
  })

  it('reports current totals, leaving out what no longer exists', () => {
    assert.deepEqual(stats.totals, {
      users: 2, onboarded: 1, clubs: 1, clubMembers: 2, favorites: 2,
      registrationEvents: 1, registrations: 1, paidOrders: 3, paidAmount: 44200, refundAmount: 16500,
    })
  })
})
