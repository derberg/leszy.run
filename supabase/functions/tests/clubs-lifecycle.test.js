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

describe('request-join', () => {
  it('creates a pending membership without setting club_id', async () => {
    const owner = await createTestSession('rj-owner')
    const joiner = await createTestSession('rj-joiner')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Do Zapisu Test' }, owner.sessionToken)
      clubId = c.data.data.club.id

      const res = await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.status, 'pending')

      const { data: m } = await supabaseAdmin.from('club_members')
        .select('status').eq('club_id', clubId).eq('user_id', joiner.user.id).single()
      assert.equal(m.status, 'pending')

      const { data: p } = await supabaseAdmin.from('profiles').select('club_id').eq('id', joiner.user.id).single()
      assert.equal(p.club_id, null) // pending must NOT set club_id
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
      await cleanupUser(joiner.user.id)
    }
  })

  it('is idempotent when already pending', async () => {
    const owner = await createTestSession('rj2-owner')
    const joiner = await createTestSession('rj2-joiner')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Idempotent Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)
      const again = await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)
      assert.equal(again.status, 200)
      assert.equal(again.data.data.status, 'pending')
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
      await cleanupUser(joiner.user.id)
    }
  })
})

describe('respond-join', () => {
  it('owner approves a pending request → active + club_id set', async () => {
    const owner = await createTestSession('resp-owner')
    const joiner = await createTestSession('resp-joiner')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Approve Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)

      const res = await callFunction('respond-join',
        { club_id: clubId, user_id: joiner.user.id, action: 'approve' }, owner.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.status, 'active')

      const { data: m } = await supabaseAdmin.from('club_members')
        .select('status, joined_at').eq('club_id', clubId).eq('user_id', joiner.user.id).single()
      assert.equal(m.status, 'active')
      assert.ok(m.joined_at)
      const { data: p } = await supabaseAdmin.from('profiles').select('club_id').eq('id', joiner.user.id).single()
      assert.equal(p.club_id, clubId)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
      await cleanupUser(joiner.user.id)
    }
  })

  it('rejects a request → pending row deleted, club_id stays null', async () => {
    const owner = await createTestSession('rej-owner')
    const joiner = await createTestSession('rej-joiner')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Reject Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)

      const res = await callFunction('respond-join',
        { club_id: clubId, user_id: joiner.user.id, action: 'reject' }, owner.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.status, 'rejected')

      const { data: m } = await supabaseAdmin.from('club_members')
        .select('user_id').eq('club_id', clubId).eq('user_id', joiner.user.id).maybeSingle()
      assert.equal(m, null)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
      await cleanupUser(joiner.user.id)
    }
  })

  it('non-admin cannot respond (403)', async () => {
    const owner = await createTestSession('perm-owner')
    const joiner = await createTestSession('perm-joiner')
    const stranger = await createTestSession('perm-stranger')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Perm Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)
      const res = await callFunction('respond-join',
        { club_id: clubId, user_id: joiner.user.id, action: 'approve' }, stranger.sessionToken)
      assert.equal(res.status, 403)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
      await cleanupUser(joiner.user.id)
      await cleanupUser(stranger.user.id)
    }
  })
})

async function joinActive(owner, joiner, clubId) {
  await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)
  await callFunction('respond-join', { club_id: clubId, user_id: joiner.user.id, action: 'approve' }, owner.sessionToken)
}

describe('manage-member', () => {
  it('member leaves → membership gone, club_id cleared', async () => {
    const owner = await createTestSession('mm-owner')
    const member = await createTestSession('mm-member')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Leave Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, member, clubId)

      const res = await callFunction('manage-member', { club_id: clubId, action: 'leave' }, member.sessionToken)
      assert.equal(res.status, 200)
      const { data: m } = await supabaseAdmin.from('club_members')
        .select('user_id').eq('club_id', clubId).eq('user_id', member.user.id).maybeSingle()
      assert.equal(m, null)
      const { data: p } = await supabaseAdmin.from('profiles').select('club_id').eq('id', member.user.id).single()
      assert.equal(p.club_id, null)
    } finally {
      await cleanupClub(clubId); await cleanupUser(owner.user.id); await cleanupUser(member.user.id)
    }
  })

  it('owner cannot leave (409)', async () => {
    const owner = await createTestSession('mm-owner2')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Owner Leave Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      const res = await callFunction('manage-member', { club_id: clubId, action: 'leave' }, owner.sessionToken)
      assert.equal(res.status, 409)
    } finally {
      await cleanupClub(clubId); await cleanupUser(owner.user.id)
    }
  })

  it('owner promotes a member to admin then removes them', async () => {
    const owner = await createTestSession('mm-owner3')
    const member = await createTestSession('mm-member3')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Role Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, member, clubId)

      const promote = await callFunction('manage-member',
        { club_id: clubId, action: 'set-role', user_id: member.user.id, role: 'admin' }, owner.sessionToken)
      assert.equal(promote.status, 200)
      assert.equal(promote.data.data.role, 'admin')

      const remove = await callFunction('manage-member',
        { club_id: clubId, action: 'remove', user_id: member.user.id }, owner.sessionToken)
      assert.equal(remove.status, 200)
      const { data: p } = await supabaseAdmin.from('profiles').select('club_id').eq('id', member.user.id).single()
      assert.equal(p.club_id, null)
    } finally {
      await cleanupClub(clubId); await cleanupUser(owner.user.id); await cleanupUser(member.user.id)
    }
  })

  it('member toggles own hidden_public', async () => {
    const owner = await createTestSession('mm-owner4')
    const member = await createTestSession('mm-member4')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Hide Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, member, clubId)
      const res = await callFunction('manage-member',
        { club_id: clubId, action: 'set-visibility', hidden_public: true }, member.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.hidden_public, true)
      const { data: m } = await supabaseAdmin.from('club_members')
        .select('hidden_public').eq('club_id', clubId).eq('user_id', member.user.id).single()
      assert.equal(m.hidden_public, true)
    } finally {
      await cleanupClub(clubId); await cleanupUser(owner.user.id); await cleanupUser(member.user.id)
    }
  })
})
