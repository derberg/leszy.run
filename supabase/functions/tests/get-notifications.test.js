import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, callFunction, supabaseAdmin } from './helpers.js'

async function createTestEvent() {
  const { data, error } = await supabaseAdmin
    .from('calendar_events')
    .insert({
      name: `Notif Test Bieg ${Date.now()}`,
      date: '2030-01-01',
      source: 'test',
      source_id: `notif-test-${crypto.randomUUID()}`,
      status: 'active',
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

describe('get-notifications', () => {
  it('shows notifications created after starring, not before', async () => {
    const me = await createTestSession('gn')
    const earlyEvent = await createTestEvent()  // notification BEFORE star
    const lateEvent = await createTestEvent()   // notification AFTER star
    try {
      await supabaseAdmin.from('event_notifications')
        .insert({ event_id: earlyEvent, type: 'registration_opened' })
      await supabaseAdmin.from('event_favorites')
        .insert({ user_id: me.user.id, event_id: earlyEvent })

      await supabaseAdmin.from('event_favorites')
        .insert({ user_id: me.user.id, event_id: lateEvent, created_at: new Date(Date.now() - 60_000).toISOString() })
      await supabaseAdmin.from('event_notifications')
        .insert({ event_id: lateEvent, type: 'cancelled' })

      const res = await callFunction('get-notifications', {}, me.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.notifications.length, 1)
      assert.equal(res.data.notifications[0].event_id, lateEvent)
      assert.equal(res.data.notifications[0].type, 'cancelled')
      assert.ok(res.data.notifications[0].event_name)
      assert.equal(res.data.unseenCount, 1)
    } finally {
      await supabaseAdmin.from('event_favorites').delete().eq('user_id', me.user.id)
      await supabaseAdmin.from('calendar_events').delete().in('id', [earlyEvent, lateEvent])
      await cleanupUser(me.user.id)
    }
  })

  it('markSeen zeroes unseenCount on next read but keeps the feed', async () => {
    const me = await createTestSession('gn-seen')
    const eventId = await createTestEvent()
    try {
      await supabaseAdmin.from('event_favorites')
        .insert({ user_id: me.user.id, event_id: eventId, created_at: new Date(Date.now() - 60_000).toISOString() })
      await supabaseAdmin.from('event_notifications')
        .insert({ event_id: eventId, type: 'deadline_soon' })

      const first = await callFunction('get-notifications', { markSeen: true }, me.sessionToken)
      assert.equal(first.data.unseenCount, 1) // counted against the PRE-markSeen cursor

      const second = await callFunction('get-notifications', {}, me.sessionToken)
      assert.equal(second.data.notifications.length, 1)
      assert.equal(second.data.unseenCount, 0)
    } finally {
      await supabaseAdmin.from('event_favorites').delete().eq('user_id', me.user.id)
      await supabaseAdmin.from('calendar_events').delete().eq('id', eventId)
      await cleanupUser(me.user.id)
    }
  })

  it('requires auth', async () => {
    const res = await callFunction('get-notifications', {})
    assert.equal(res.status, 401)
  })
})
