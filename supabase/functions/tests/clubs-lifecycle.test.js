import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, cleanupClub, callFunction, supabaseAdmin } from './helpers.js'

describe('create-club', () => {
  it('creates a club, makes caller owner, sets profile.club_id', async () => {
    const u = await createTestSession('create-owner')
    let clubId
    try {
      const res = await callFunction('create-club', { name: 'Górska Drużyna Test' }, u.sessionToken)
      assert.equal(res.status, 200)
      clubId = res.data.data.club.id
      assert.equal(res.data.data.club.slug, 'gorska-druzyna-test')
      assert.equal(res.data.data.club.owner_id, u.user.id)

      const { data: m } = await supabaseAdmin.from('club_members')
        .select('role, status').eq('club_id', clubId).eq('user_id', u.user.id).single()
      assert.equal(m.role, 'owner')
      assert.equal(m.status, 'active')

      const { data: p } = await supabaseAdmin.from('profiles')
        .select('club_id').eq('id', u.user.id).single()
      assert.equal(p.club_id, clubId)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(u.user.id)
    }
  })

  it('rejects a second club while already an active member (409)', async () => {
    const u = await createTestSession('create-twice')
    let clubId
    try {
      const first = await callFunction('create-club', { name: 'Klub Jeden Test' }, u.sessionToken)
      clubId = first.data.data.club.id
      const second = await callFunction('create-club', { name: 'Klub Dwa Test' }, u.sessionToken)
      assert.equal(second.status, 409)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(u.user.id)
    }
  })

  it('requires a non-empty name (400)', async () => {
    const u = await createTestSession('create-noname')
    try {
      const res = await callFunction('create-club', { name: '   ' }, u.sessionToken)
      assert.equal(res.status, 400)
    } finally {
      await cleanupUser(u.user.id)
    }
  })
})
