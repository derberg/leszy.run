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
      { paid_at: '2026-11-03T16:05:00Z', total: 20000 },
      { paid_at: '2026-11-03T19:05:00Z', total: 20000 },
      { paid_at: null, total: 5000 },
    ],
  }
  const stats = buildAdminStats(raw, { now, months: 3 })

  it('counts each metric in the month it happened', () => {
    const nov = stats.months.find((m) => m.month === '2026-11')
    assert.deepEqual(nov, {
      month: '2026-11', users: 2, onboarded: 1, clubs: 0, clubJoins: 2, favorites: 1,
      registrationEvents: 1, registrations: 1, paidOrders: 2, paidAmount: 40000,
    })
    const oct = stats.months.find((m) => m.month === '2026-10')
    assert.equal(oct.users, 1)
    assert.equal(oct.clubs, 1)
    assert.equal(oct.clubJoins, 0, 'the owner founding the club is not a join')
  })

  it('returns exactly the requested months, newest first, zero-filled', () => {
    assert.deepEqual(stats.months.map((m) => m.month), ['2026-11', '2026-10', '2026-09'])
    assert.equal(stats.months[2].favorites, 1)
    assert.equal(stats.months[2].users, 0)
  })

  it('reports current totals, leaving out what no longer exists', () => {
    assert.deepEqual(stats.totals, {
      users: 2, onboarded: 1, clubs: 1, clubMembers: 2, favorites: 2,
      registrationEvents: 1, registrations: 1, paidOrders: 2, paidAmount: 40000,
    })
  })
})
