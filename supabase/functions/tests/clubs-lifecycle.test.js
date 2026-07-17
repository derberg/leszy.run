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

describe('update-club', () => {
  it('owner updates description/city/voivodeship/is_public', async () => {
    const owner = await createTestSession('uc-owner1')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Update Test' }, owner.sessionToken)
      clubId = c.data.data.club.id

      const res = await callFunction('update-club', {
        club_id: clubId, description: 'Nowy opis', city: 'Kraków', voivodeship: 'Małopolskie', is_public: false,
      }, owner.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.club.description, 'Nowy opis')
      assert.equal(res.data.data.club.city, 'Kraków')
      assert.equal(res.data.data.club.voivodeship, 'Małopolskie')
      assert.equal(res.data.data.club.is_public, false)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
    }
  })

  it('renaming regenerates a unique slug and normalized_name', async () => {
    const owner = await createTestSession('uc-owner2')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Stara Nazwa Test' }, owner.sessionToken)
      clubId = c.data.data.club.id

      const res = await callFunction('update-club',
        { club_id: clubId, name: 'Klub Nowa Nazwa Test' }, owner.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.club.name, 'Klub Nowa Nazwa Test')
      assert.equal(res.data.data.club.slug, 'klub-nowa-nazwa-test')

      const { data: club } = await supabaseAdmin.from('clubs')
        .select('normalized_name').eq('id', clubId).single()
      assert.equal(club.normalized_name, 'klub nowa nazwa test')
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
    }
  })

  it('rejects renaming to a name already used by another club (409)', async () => {
    const owner = await createTestSession('uc-owner3')
    let clubId1, clubId2
    try {
      const c1 = await callFunction('create-club', { name: 'Klub Zajety Test' }, owner.sessionToken)
      clubId1 = c1.data.data.club.id
      const owner2 = await createTestSession('uc-owner3b')
      try {
        const c2 = await callFunction('create-club', { name: 'Klub Drugi Test' }, owner2.sessionToken)
        clubId2 = c2.data.data.club.id

        const res = await callFunction('update-club',
          { club_id: clubId2, name: 'Klub Zajety Test' }, owner2.sessionToken)
        assert.equal(res.status, 409)
      } finally {
        await cleanupClub(clubId2)
        await cleanupUser(owner2.user.id)
      }
    } finally {
      await cleanupClub(clubId1)
      await cleanupUser(owner.user.id)
    }
  })

  it('non-manager cannot update (403)', async () => {
    const owner = await createTestSession('uc-owner4')
    const member = await createTestSession('uc-member4')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Update Perm Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, member, clubId)

      const res = await callFunction('update-club',
        { club_id: clubId, description: 'x' }, member.sessionToken)
      assert.equal(res.status, 403)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id); await cleanupUser(member.user.id)
    }
  })

  it('admin (non-owner) can update', async () => {
    const owner = await createTestSession('uc-owner5')
    const admin = await createTestSession('uc-admin5')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Update Admin Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, admin, clubId)
      await callFunction('manage-member',
        { club_id: clubId, action: 'set-role', user_id: admin.user.id, role: 'admin' }, owner.sessionToken)

      const res = await callFunction('update-club',
        { club_id: clubId, description: 'Opis od admina' }, admin.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.club.description, 'Opis od admina')
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id); await cleanupUser(admin.user.id)
    }
  })
})

describe('delete-club', () => {
  it('owner deletes the club — members/invites cascade, profiles.club_id clears', async () => {
    const owner = await createTestSession('dc-owner1')
    const member = await createTestSession('dc-member1')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Delete Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, member, clubId)

      const res = await callFunction('delete-club', { club_id: clubId }, owner.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.deleted, true)

      const { data: club } = await supabaseAdmin.from('clubs').select('id').eq('id', clubId).maybeSingle()
      assert.equal(club, null)

      const { data: members } = await supabaseAdmin.from('club_members').select('user_id').eq('club_id', clubId)
      assert.deepEqual(members, [])

      const { data: ownerProfile } = await supabaseAdmin.from('profiles')
        .select('club_id').eq('id', owner.user.id).single()
      assert.equal(ownerProfile.club_id, null)
      const { data: memberProfile } = await supabaseAdmin.from('profiles')
        .select('club_id').eq('id', member.user.id).single()
      assert.equal(memberProfile.club_id, null)

      clubId = null // already deleted; skip cleanupClub's redundant delete
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id); await cleanupUser(member.user.id)
    }
  })

  it('non-owner (admin) cannot delete (403)', async () => {
    const owner = await createTestSession('dc-owner2')
    const admin = await createTestSession('dc-admin2')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Delete Perm Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, admin, clubId)
      await callFunction('manage-member',
        { club_id: clubId, action: 'set-role', user_id: admin.user.id, role: 'admin' }, owner.sessionToken)

      const res = await callFunction('delete-club', { club_id: clubId }, admin.sessionToken)
      assert.equal(res.status, 403)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id); await cleanupUser(admin.user.id)
    }
  })
})

describe('get-club', () => {
  it('non-member gets 200 with club: null (not 403)', async () => {
    const owner = await createTestSession('gc-owner1')
    const stranger = await createTestSession('gc-stranger1')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub GetClub Perm Test' }, owner.sessionToken)
      clubId = c.data.data.club.id

      const res = await callFunction('get-club', { club_id: clubId }, stranger.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.club, null)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id); await cleanupUser(stranger.user.id)
    }
  })

  it('includes pending members in the roster with status, active members listed first', async () => {
    const owner = await createTestSession('gc-owner4')
    const joiner = await createTestSession('gc-joiner4')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub GetClub Pending Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)

      const res = await callFunction('get-club', { club_id: clubId }, owner.sessionToken)
      assert.equal(res.status, 200)
      const members = res.data.data.members
      const ownerRow = members.find((m) => m.user_id === owner.user.id)
      const joinerRow = members.find((m) => m.user_id === joiner.user.id)
      assert.equal(ownerRow.status, 'active')
      assert.equal(joinerRow.status, 'pending')
      const firstPendingIdx = members.findIndex((m) => m.status === 'pending')
      const lastActiveIdx = members.map((m) => m.status).lastIndexOf('active')
      assert.ok(firstPendingIdx > lastActiveIdx, 'active members must be listed before pending ones')
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id); await cleanupUser(joiner.user.id)
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

describe('delete-my-account — club ownership guard', () => {
  it('blocks deletion while the caller owns a club (409, lists the club, account NOT deleted)', async () => {
    const owner = await createTestSession('dma-owner1')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub DeleteGuard Test' }, owner.sessionToken)
      clubId = c.data.data.club.id

      const res = await callFunction('delete-my-account', { action: 'request' }, owner.sessionToken)
      assert.equal(res.status, 409)
      assert.ok(Array.isArray(res.data.clubs))
      assert.ok(res.data.clubs.some((c2) => c2.id === clubId))
      assert.ok(res.data.error)

      const { data: profile } = await supabaseAdmin.from('profiles')
        .select('deleted_at').eq('id', owner.user.id).single()
      assert.equal(profile.deleted_at, null, 'account must not be deleted while owning a club')
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
    }
  })

  it('does not block a user who owns no club (existing behavior preserved)', async () => {
    const u = await createTestSession('dma-nonowner1')
    try {
      const res = await callFunction('delete-my-account', { action: 'request' }, u.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.sent, true)
    } finally {
      await supabaseAdmin.from('auth_codes').delete().eq('email', u.email.toLowerCase())
      await cleanupUser(u.user.id)
    }
  })
})

describe('export-my-data — clubs section', () => {
  it("owner's export includes clubs.owned and clubs.membership", async () => {
    const owner = await createTestSession('emd-owner1')
    let clubId
    try {
      const c = await callFunction('create-club',
        { name: 'Klub Export Test', description: 'Klub do testu eksportu danych' }, owner.sessionToken)
      clubId = c.data.data.club.id

      await callFunction('update-profile', {
        privacy_settings: { club_public_name: 'nickname' },
      }, owner.sessionToken)

      const res = await callFunction('export-my-data', {}, owner.sessionToken)
      assert.equal(res.status, 200)
      assert.ok(res.data.clubs, 'expected data.clubs to be present')

      const owned = res.data.clubs.owned.find((o) => o.name === 'Klub Export Test')
      assert.ok(owned, 'expected owned club in export')
      assert.equal(owned.description, 'Klub do testu eksportu danych')
      assert.equal(owned.member_count, 1)

      const m = res.data.clubs.membership
      assert.ok(m, 'expected membership in export')
      assert.equal(m.club_name, 'Klub Export Test')
      assert.equal(m.role, 'owner')
      assert.equal(m.status, 'active')
      assert.ok(m.joined_at)
      assert.equal(m.hidden_public, false)
      assert.equal(m.club_public_name, 'nickname')
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
    }
  })

  it('a user with no club has null membership and empty owned', async () => {
    const u = await createTestSession('emd-noclub1')
    try {
      const res = await callFunction('export-my-data', {}, u.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.clubs.membership, null)
      assert.deepEqual(res.data.clubs.owned, [])
    } finally {
      await cleanupUser(u.user.id)
    }
  })
})
