import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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

describe('update-profile clubs changes', () => {
  it('sets nickname and club_public_name; ignores club/club_id', async () => {
    const u = await createTestSession('up-clubs')
    try {
      const res = await callFunction('update-profile', {
        nickname: 'Szybki Franek',
        privacy_settings: { club_public_name: 'nickname' },
        club: 'Should Be Ignored',
        club_id: '00000000-0000-0000-0000-000000000000',
      }, u.sessionToken)
      assert.equal(res.status, 200)

      const { data: p } = await supabaseAdmin.from('profiles')
        .select('nickname, club_id, privacy_settings').eq('id', u.user.id).single()
      assert.equal(p.nickname, 'Szybki Franek')
      assert.equal(p.club_id, null) // club/club_id in the body must be ignored
      assert.equal(p.privacy_settings.club_public_name, 'nickname')
    } finally {
      await cleanupUser(u.user.id)
    }
  })

  it('rejects an over-long nickname (400)', async () => {
    const u = await createTestSession('up-longnick')
    try {
      const res = await callFunction('update-profile', { nickname: 'x'.repeat(61) }, u.sessionToken)
      assert.equal(res.status, 400)
    } finally {
      await cleanupUser(u.user.id)
    }
  })
})

describe('transfer-ownership', () => {
  it('non-owner nominate → 403', async () => {
    const owner = await createTestSession('to-owner1')
    const member = await createTestSession('to-member1')
    const stranger = await createTestSession('to-stranger1')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Transfer Perm Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, member, clubId)

      const res = await callFunction('transfer-ownership',
        { club_id: clubId, op: 'nominate', user_id: member.user.id }, stranger.sessionToken)
      assert.equal(res.status, 403)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id); await cleanupUser(member.user.id); await cleanupUser(stranger.user.id)
    }
  })

  it('owner nominates an active member → clubs.pending_owner_id set', async () => {
    const owner = await createTestSession('to-owner2')
    const member = await createTestSession('to-member2')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Transfer Nominate Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, member, clubId)

      const res = await callFunction('transfer-ownership',
        { club_id: clubId, op: 'nominate', user_id: member.user.id }, owner.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.pending_owner_id, member.user.id)

      const { data: club } = await supabaseAdmin.from('clubs').select('pending_owner_id').eq('id', clubId).single()
      assert.equal(club.pending_owner_id, member.user.id)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id); await cleanupUser(member.user.id)
    }
  })

  it('nominee accept → ownership + roles swap, pending cleared', async () => {
    const owner = await createTestSession('to-owner3')
    const member = await createTestSession('to-member3')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Transfer Accept Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, member, clubId)
      await callFunction('transfer-ownership',
        { club_id: clubId, op: 'nominate', user_id: member.user.id }, owner.sessionToken)

      const res = await callFunction('transfer-ownership', { club_id: clubId, op: 'accept' }, member.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.owner_id, member.user.id)

      const { data: club } = await supabaseAdmin.from('clubs')
        .select('owner_id, pending_owner_id').eq('id', clubId).single()
      assert.equal(club.owner_id, member.user.id)
      assert.equal(club.pending_owner_id, null)

      const { data: newOwnerRow } = await supabaseAdmin.from('club_members')
        .select('role').eq('club_id', clubId).eq('user_id', member.user.id).single()
      assert.equal(newOwnerRow.role, 'owner')

      const { data: oldOwnerRow } = await supabaseAdmin.from('club_members')
        .select('role').eq('club_id', clubId).eq('user_id', owner.user.id).single()
      assert.equal(oldOwnerRow.role, 'admin')
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id); await cleanupUser(member.user.id)
    }
  })

  it('decline clears pending without changing owner', async () => {
    const owner = await createTestSession('to-owner4')
    const member = await createTestSession('to-member4')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Transfer Decline Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, member, clubId)
      await callFunction('transfer-ownership',
        { club_id: clubId, op: 'nominate', user_id: member.user.id }, owner.sessionToken)

      const res = await callFunction('transfer-ownership', { club_id: clubId, op: 'decline' }, member.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.declined, true)

      const { data: club } = await supabaseAdmin.from('clubs')
        .select('owner_id, pending_owner_id').eq('id', clubId).single()
      assert.equal(club.owner_id, owner.user.id)
      assert.equal(club.pending_owner_id, null)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id); await cleanupUser(member.user.id)
    }
  })

  it('cancel by owner clears pending', async () => {
    const owner = await createTestSession('to-owner5')
    const member = await createTestSession('to-member5')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Transfer Cancel Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, member, clubId)
      await callFunction('transfer-ownership',
        { club_id: clubId, op: 'nominate', user_id: member.user.id }, owner.sessionToken)

      const res = await callFunction('transfer-ownership', { club_id: clubId, op: 'cancel' }, owner.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.cancelled, true)

      const { data: club } = await supabaseAdmin.from('clubs').select('pending_owner_id').eq('id', clubId).single()
      assert.equal(club.pending_owner_id, null)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id); await cleanupUser(member.user.id)
    }
  })
})

describe('get-club', () => {
  it('non-member gets 403', async () => {
    const owner = await createTestSession('gc-owner1')
    const stranger = await createTestSession('gc-stranger1')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub GetClub Perm Test' }, owner.sessionToken)
      clubId = c.data.data.club.id

      const res = await callFunction('get-club', { club_id: clubId }, stranger.sessionToken)
      assert.equal(res.status, 403)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id); await cleanupUser(stranger.user.id)
    }
  })

  it('member gets club, me, members, and followedEvents', async () => {
    const owner = await createTestSession('gc-owner2')
    const member = await createTestSession('gc-member2')
    let clubId, eventId

    try {
      const c = await callFunction('create-club', { name: 'Klub GetClub Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, member, clubId)

      const { data: ev } = await supabaseAdmin.from('calendar_events')
        .insert({
          name: `GetClub Followed Bieg ${Date.now()}`, date: '2030-01-01',
          source: 'test', source_id: `get-club-${crypto.randomUUID()}`, status: 'active',
        })
        .select('id').single()
      eventId = ev.id

      await supabaseAdmin.from('event_favorites').insert([
        { user_id: owner.user.id, event_id: eventId },
        { user_id: member.user.id, event_id: eventId },
      ])

      const res = await callFunction('get-club', { club_id: clubId }, member.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.club.id, clubId)
      assert.equal(res.data.data.me.role, 'member')

      const memberIds = res.data.data.members.map((m) => m.user_id).sort()
      assert.deepEqual(memberIds, [owner.user.id, member.user.id].sort())
      const meRow = res.data.data.members.find((m) => m.user_id === member.user.id)
      assert.ok('display_name' in meRow && 'nickname' in meRow && 'hidden_public' in meRow)

      const followed = res.data.data.followedEvents.find((f) => f.event.id === eventId)
      assert.ok(followed, 'expected the shared favorite to appear in followedEvents')
      assert.ok(followed.count >= 2)
    } finally {
      if (eventId) {
        await supabaseAdmin.from('event_favorites').delete().eq('event_id', eventId)
        await supabaseAdmin.from('calendar_events').delete().eq('id', eventId)
      }
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id); await cleanupUser(member.user.id)
    }
  })

  it('defaults to the caller\'s active club when club_id is omitted', async () => {
    const owner = await createTestSession('gc-owner3')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub GetClub Default Test' }, owner.sessionToken)
      clubId = c.data.data.club.id

      const res = await callFunction('get-club', {}, owner.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.club.id, clubId)
      assert.equal(res.data.data.me.role, 'owner')
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
    }
  })
})
