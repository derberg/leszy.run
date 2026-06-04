import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, callFunction, supabaseAdmin } from './helpers.js'

async function createTestEvent() {
  const { data, error } = await supabaseAdmin
    .from('calendar_events')
    .insert({
      name: `GetFav Test Bieg ${Date.now()}`,
      date: '2030-01-01',
      source: 'test',
      source_id: `getfav-test-${crypto.randomUUID()}`,
      status: 'active',
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

async function createClub() {
  const name = `Test Klub ${crypto.randomUUID().slice(0, 8)}`
  const { data, error } = await supabaseAdmin
    .from('clubs')
    .insert({ name, normalized_name: name.toLowerCase() })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

describe('get-favorites', () => {
  it('returns own starred events and club counts respecting privacy', async () => {
    const clubId = await createClub()
    const otherClubId = await createClub()
    const me = await createTestSession('gf-me')
    const mate = await createTestSession('gf-mate')        // same club, default privacy
    const hiddenMate = await createTestSession('gf-hidden') // same club, favorites=false
    const stranger = await createTestSession('gf-stranger') // different club
    const eventId = await createTestEvent()

    try {
      await supabaseAdmin.from('profiles').update({ club_id: clubId }).eq('id', me.user.id)
      await supabaseAdmin.from('profiles').update({ club_id: clubId }).eq('id', mate.user.id)
      await supabaseAdmin.from('profiles')
        .update({ club_id: clubId, privacy_settings: { favorites: false } })
        .eq('id', hiddenMate.user.id)
      await supabaseAdmin.from('profiles').update({ club_id: otherClubId }).eq('id', stranger.user.id)

      for (const u of [me, mate, hiddenMate, stranger]) {
        await supabaseAdmin.from('event_favorites').insert({ user_id: u.user.id, event_id: eventId })
      }

      const res = await callFunction('get-favorites', {}, me.sessionToken)
      assert.equal(res.status, 200)

      assert.equal(res.data.events.length, 1)
      assert.equal(res.data.events[0].id, eventId)
      assert.ok(res.data.events[0].name)
      assert.equal(res.data.events[0].status, 'active')

      // only `mate` counts — not me, not hiddenMate (privacy off), not stranger (other club)
      assert.equal(res.data.clubCounts[eventId], 1)
    } finally {
      for (const u of [me, mate, hiddenMate, stranger]) {
        await supabaseAdmin.from('event_favorites').delete().eq('user_id', u.user.id)
      }
      await supabaseAdmin.from('calendar_events').delete().eq('id', eventId)
      for (const u of [me, mate, hiddenMate, stranger]) await cleanupUser(u.user.id)
      await supabaseAdmin.from('clubs').delete().in('id', [clubId, otherClubId])
    }
  })

  it('returns empty clubCounts for users without a club', async () => {
    const me = await createTestSession('gf-noclub')
    try {
      const res = await callFunction('get-favorites', {}, me.sessionToken)
      assert.equal(res.status, 200)
      assert.deepEqual(res.data.events, [])
      assert.deepEqual(res.data.clubCounts, {})
    } finally {
      await cleanupUser(me.user.id)
    }
  })

  it('starred events that get rejected drop out of the list', async () => {
    const me = await createTestSession('gf-reject')
    const eventId = await createTestEvent()

    try {
      await supabaseAdmin.from('event_favorites').insert({ user_id: me.user.id, event_id: eventId })

      await supabaseAdmin.from('calendar_events').update({ status: 'rejected' }).eq('id', eventId)

      const res = await callFunction('get-favorites', {}, me.sessionToken)
      assert.equal(res.status, 200)
      assert.deepEqual(res.data.events, [])
    } finally {
      await supabaseAdmin.from('event_favorites').delete().eq('user_id', me.user.id)
      await supabaseAdmin.from('calendar_events').delete().eq('id', eventId)
      await cleanupUser(me.user.id)
    }
  })

  it('requires auth', async () => {
    const res = await callFunction('get-favorites', {})
    assert.equal(res.status, 401)
  })
})
