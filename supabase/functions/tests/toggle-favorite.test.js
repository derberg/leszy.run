import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, callFunction, supabaseAdmin } from './helpers.js'

async function createTestEvent(status = 'active') {
  const { data, error } = await supabaseAdmin
    .from('calendar_events')
    .insert({
      name: `Fav Test Bieg ${Date.now()}`,
      date: '2030-01-01',
      source: 'test',
      source_id: `fav-test-${crypto.randomUUID()}`,
      status,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

describe('toggle-favorite', () => {
  it('stars then unstars', async () => {
    const { user, sessionToken } = await createTestSession('fav')
    const eventId = await createTestEvent()
    try {
      const on = await callFunction('toggle-favorite', { event_id: eventId }, sessionToken)
      assert.equal(on.status, 200)
      assert.equal(on.data.starred, true)

      const { count } = await supabaseAdmin
        .from('event_favorites')
        .select('event_id', { count: 'exact', head: true })
        .eq('user_id', user.id)
      assert.equal(count, 1)

      const off = await callFunction('toggle-favorite', { event_id: eventId }, sessionToken)
      assert.equal(off.data.starred, false)

      const { count: after } = await supabaseAdmin
        .from('event_favorites')
        .select('event_id', { count: 'exact', head: true })
        .eq('user_id', user.id)
      assert.equal(after, 0)
    } finally {
      await supabaseAdmin.from('calendar_events').delete().eq('id', eventId)
      await cleanupUser(user.id)
    }
  })

  it('requires auth', async () => {
    const res = await callFunction('toggle-favorite', { event_id: crypto.randomUUID() })
    assert.equal(res.status, 401)
  })

  it('rejects unknown and rejected events with 404', async () => {
    const { user, sessionToken } = await createTestSession('fav404')
    const rejectedId = await createTestEvent('rejected')
    try {
      const unknown = await callFunction('toggle-favorite', { event_id: crypto.randomUUID() }, sessionToken)
      assert.equal(unknown.status, 404)

      const rejected = await callFunction('toggle-favorite', { event_id: rejectedId }, sessionToken)
      assert.equal(rejected.status, 404)
    } finally {
      await supabaseAdmin.from('calendar_events').delete().eq('id', rejectedId)
      await cleanupUser(user.id)
    }
  })

  it('allows starring a cancelled event', async () => {
    const { user, sessionToken } = await createTestSession('favcanc')
    const eventId = await createTestEvent('cancelled')
    try {
      const res = await callFunction('toggle-favorite', { event_id: eventId }, sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.starred, true)
    } finally {
      await supabaseAdmin.from('calendar_events').delete().eq('id', eventId)
      await cleanupUser(user.id)
    }
  })
})
