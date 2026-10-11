import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { eventIsStillAhead, pickDigestNotifications } from '../scripts/lib/notificationWindow.js'

const TODAY = '2026-09-29'

describe('eventIsStillAhead', () => {
  it('keeps an active race that has not happened yet', () => {
    assert.equal(eventIsStillAhead({ status: 'active', date: '2026-10-05' }, TODAY), true)
    assert.equal(eventIsStillAhead({ status: 'active', date: TODAY }, TODAY), true)
  })

  it('drops a race that already happened', () => {
    assert.equal(eventIsStillAhead({ status: 'active', date: '2026-09-01' }, TODAY), false)
  })

  it('drops an event the admin rejected, whatever its date', () => {
    assert.equal(eventIsStillAhead({ status: 'rejected', date: '2026-10-05' }, TODAY), false)
    assert.equal(eventIsStillAhead({ status: 'pending', date: '2026-10-05' }, TODAY), false)
  })

  it('keeps a cancelled race — the follower wants to hear that one', () => {
    assert.equal(eventIsStillAhead({ status: 'cancelled', date: '2026-10-05' }, TODAY), true)
  })

  it('drops an event it cannot date rather than guessing', () => {
    assert.equal(eventIsStillAhead({ status: 'active', date: null }, TODAY), false)
    assert.equal(eventIsStillAhead(null, TODAY), false)
  })
})

describe('pickDigestNotifications', () => {
  const ev = (over = {}) => ({ name: 'Bieg', date: '2026-10-05', status: 'active', ...over })
  const notif = (over = {}) => ({
    event_id: 'e1', type: 'deadline_soon', created_at: '2026-09-28T08:00:00Z',
    calendar_events: ev(), ...over,
  })

  it('keeps a notification raised after the user starred the race', () => {
    const out = pickDigestNotifications([notif()], new Map([['e1', '2026-09-01T00:00:00Z']]), '2026-09-22T00:00:00Z', TODAY)
    assert.equal(out.length, 1)
  })

  it('drops one raised before the user starred it — they were told nothing new', () => {
    const out = pickDigestNotifications([notif()], new Map([['e1', '2026-09-29T00:00:00Z']]), '2026-09-22T00:00:00Z', TODAY)
    assert.deepEqual(out, [])
  })

  it('drops a race that has already been run', () => {
    const out = pickDigestNotifications(
      [notif({ calendar_events: ev({ date: '2026-09-02' }) })],
      new Map([['e1', '2026-09-01T00:00:00Z']]), '2026-09-22T00:00:00Z', TODAY,
    )
    assert.deepEqual(out, [])
  })

  it('drops a rejected event — its public page does not exist, so the link is dead', () => {
    const out = pickDigestNotifications(
      [notif({ calendar_events: ev({ status: 'rejected' }) })],
      new Map([['e1', '2026-09-01T00:00:00Z']]), '2026-09-22T00:00:00Z', TODAY,
    )
    assert.deepEqual(out, [])
  })

  it('drops anything the user was already mailed about', () => {
    const out = pickDigestNotifications([notif()], new Map([['e1', '2026-09-01T00:00:00Z']]), '2026-09-29T00:00:00Z', TODAY)
    assert.deepEqual(out, [], 'a notification older than this user last digest must not be re-sent')
  })

  it('ignores an event the user does not follow', () => {
    const out = pickDigestNotifications([notif()], new Map([['other', '2026-09-01T00:00:00Z']]), '2026-09-22T00:00:00Z', TODAY)
    assert.deepEqual(out, [])
  })
})
