import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, cleanupClub, callFunction, supabaseAdmin, createClub } from './helpers.js'

describe('manage-club-invite', () => {
  let owner, ownerToken, outsider, outsiderToken, club
  before(async () => {
    ;({ user: owner, sessionToken: ownerToken } = await createTestSession('inv-owner'))
    ;({ user: outsider, sessionToken: outsiderToken } = await createTestSession('inv-out'))
    club = await createClub(ownerToken, 'Invite Test Club')
  })
  after(async () => {
    await cleanupClub(club.id)
    await cleanupUser(owner.id); await cleanupUser(outsider.id)
  })

  it('403 for non-member', async () => {
    const { status } = await callFunction('manage-club-invite', { club_id: club.id, op: 'create-link' }, outsiderToken)
    assert.equal(status, 403)
  })

  it('owner creates a link invite with a code', async () => {
    const { status, data } = await callFunction('manage-club-invite', { club_id: club.id, op: 'create-link', max_uses: 5 }, ownerToken)
    assert.equal(status, 200)
    assert.ok(data.data.invite.code && data.data.invite.code.length >= 6)

    const { data: row } = await supabaseAdmin.from('club_invites')
      .select('kind, code, max_uses, uses, revoked').eq('id', data.data.invite.id).single()
    assert.equal(row.kind, 'link')
    assert.equal(row.code, data.data.invite.code)
    assert.equal(row.max_uses, 5)
    assert.equal(row.uses, 0)
    assert.equal(row.revoked, false)
  })

  it('owner creates a direct invite with an email', async () => {
    const { status, data } = await callFunction('manage-club-invite',
      { club_id: club.id, op: 'create-direct', email: 'kolega@example.com' }, ownerToken)
    assert.equal(status, 200)
    assert.ok(data.data.invite.id)

    const { data: row } = await supabaseAdmin.from('club_invites')
      .select('kind, target_email').eq('id', data.data.invite.id).single()
    assert.equal(row.kind, 'direct')
    assert.equal(row.target_email, 'kolega@example.com')
  })

  it('create-direct requires email or username (400)', async () => {
    const { status } = await callFunction('manage-club-invite', { club_id: club.id, op: 'create-direct' }, ownerToken)
    assert.equal(status, 400)
  })

  it('revoke sets revoked=true', async () => {
    const created = await callFunction('manage-club-invite', { club_id: club.id, op: 'create-link' }, ownerToken)
    const inviteId = created.data.data.invite.id

    const { status, data } = await callFunction('manage-club-invite',
      { club_id: club.id, op: 'revoke', invite_id: inviteId }, ownerToken)
    assert.equal(status, 200)
    assert.equal(data.data.revoked, true)

    const { data: row } = await supabaseAdmin.from('club_invites').select('revoked').eq('id', inviteId).single()
    assert.equal(row.revoked, true)
  })

  it('list returns only active (non-revoked, unexpired) invites', async () => {
    const kept = await callFunction('manage-club-invite', { club_id: club.id, op: 'create-link' }, ownerToken)
    const revoked = await callFunction('manage-club-invite', { club_id: club.id, op: 'create-link' }, ownerToken)
    await callFunction('manage-club-invite', { club_id: club.id, op: 'revoke', invite_id: revoked.data.data.invite.id }, ownerToken)

    const past = new Date(Date.now() - 60 * 1000).toISOString()
    const expired = await callFunction('manage-club-invite', { club_id: club.id, op: 'create-link', expires_at: past }, ownerToken)

    const { status, data } = await callFunction('manage-club-invite', { club_id: club.id, op: 'list' }, ownerToken)
    assert.equal(status, 200)
    const ids = data.data.invites.map(i => i.id)
    assert.ok(ids.includes(kept.data.data.invite.id))
    assert.ok(!ids.includes(revoked.data.data.invite.id))
    assert.ok(!ids.includes(expired.data.data.invite.id))
  })

  it('unknown op → 400', async () => {
    const { status } = await callFunction('manage-club-invite', { club_id: club.id, op: 'bogus' }, ownerToken)
    assert.equal(status, 400)
  })
})

describe('accept-invite', () => {
  it('valid link code → active membership + profile.club_id set', async () => {
    const owner = await createTestSession('acc-owner')
    const joiner = await createTestSession('acc-joiner')
    let club
    try {
      club = await createClub(owner.sessionToken, 'Accept Test Club')
      const invite = await callFunction('manage-club-invite', { club_id: club.id, op: 'create-link' }, owner.sessionToken)
      const code = invite.data.data.invite.code

      const { status, data } = await callFunction('accept-invite', { code }, joiner.sessionToken)
      assert.equal(status, 200)
      assert.equal(data.data.status, 'active')
      assert.equal(data.data.club.id, club.id)

      const { data: m } = await supabaseAdmin.from('club_members')
        .select('status, role').eq('club_id', club.id).eq('user_id', joiner.user.id).single()
      assert.equal(m.status, 'active')
      assert.equal(m.role, 'member')

      const { data: p } = await supabaseAdmin.from('profiles').select('club_id').eq('id', joiner.user.id).single()
      assert.equal(p.club_id, club.id)

      const { data: inviteRow } = await supabaseAdmin.from('club_invites')
        .select('uses').eq('id', invite.data.data.invite.id).single()
      assert.equal(inviteRow.uses, 1)
    } finally {
      if (club) await cleanupClub(club.id)
      await cleanupUser(owner.user.id); await cleanupUser(joiner.user.id)
    }
  })

  it('expired code → 410', async () => {
    const owner = await createTestSession('acc-exp-owner')
    const joiner = await createTestSession('acc-exp-joiner')
    let club
    try {
      club = await createClub(owner.sessionToken, 'Accept Expired Club')
      const past = new Date(Date.now() - 60 * 1000).toISOString()
      const invite = await callFunction('manage-club-invite', { club_id: club.id, op: 'create-link', expires_at: past }, owner.sessionToken)

      const { status } = await callFunction('accept-invite', { code: invite.data.data.invite.code }, joiner.sessionToken)
      assert.equal(status, 410)
    } finally {
      if (club) await cleanupClub(club.id)
      await cleanupUser(owner.user.id); await cleanupUser(joiner.user.id)
    }
  })

  it('revoked code → 410', async () => {
    const owner = await createTestSession('acc-rev-owner')
    const joiner = await createTestSession('acc-rev-joiner')
    let club
    try {
      club = await createClub(owner.sessionToken, 'Accept Revoked Club')
      const invite = await callFunction('manage-club-invite', { club_id: club.id, op: 'create-link' }, owner.sessionToken)
      await callFunction('manage-club-invite', { club_id: club.id, op: 'revoke', invite_id: invite.data.data.invite.id }, owner.sessionToken)

      const { status } = await callFunction('accept-invite', { code: invite.data.data.invite.code }, joiner.sessionToken)
      assert.equal(status, 410)
    } finally {
      if (club) await cleanupClub(club.id)
      await cleanupUser(owner.user.id); await cleanupUser(joiner.user.id)
    }
  })

  it('maxed-out code → 409', async () => {
    const owner = await createTestSession('acc-max-owner')
    const joinerA = await createTestSession('acc-max-a')
    const joinerB = await createTestSession('acc-max-b')
    let club
    try {
      club = await createClub(owner.sessionToken, 'Accept Maxed Club')
      const invite = await callFunction('manage-club-invite', { club_id: club.id, op: 'create-link', max_uses: 1 }, owner.sessionToken)
      const code = invite.data.data.invite.code

      const first = await callFunction('accept-invite', { code }, joinerA.sessionToken)
      assert.equal(first.status, 200)

      const second = await callFunction('accept-invite', { code }, joinerB.sessionToken)
      assert.equal(second.status, 409)
    } finally {
      if (club) await cleanupClub(club.id)
      await cleanupUser(owner.user.id); await cleanupUser(joinerA.user.id); await cleanupUser(joinerB.user.id)
    }
  })

  it('user already in another active club → 409', async () => {
    const ownerA = await createTestSession('acc-own-a')
    const ownerB = await createTestSession('acc-own-b')
    let clubA, clubB
    try {
      clubA = await createClub(ownerA.sessionToken, 'Accept Club A')
      clubB = await createClub(ownerB.sessionToken, 'Accept Club B')
      const invite = await callFunction('manage-club-invite', { club_id: clubB.id, op: 'create-link' }, ownerB.sessionToken)

      // ownerA already owns (and is active in) clubA
      const { status } = await callFunction('accept-invite', { code: invite.data.data.invite.code }, ownerA.sessionToken)
      assert.equal(status, 409)
    } finally {
      if (clubA) await cleanupClub(clubA.id)
      if (clubB) await cleanupClub(clubB.id)
      await cleanupUser(ownerA.user.id); await cleanupUser(ownerB.user.id)
    }
  })

  it('direct invite accepted by invite_id', async () => {
    const owner = await createTestSession('acc-dir-owner')
    const joiner = await createTestSession('acc-dir-joiner')
    let club
    try {
      club = await createClub(owner.sessionToken, 'Accept Direct Club')
      const invite = await callFunction('manage-club-invite',
        { club_id: club.id, op: 'create-direct', email: joiner.email }, owner.sessionToken)

      const { status, data } = await callFunction('accept-invite', { invite_id: invite.data.data.invite.id }, joiner.sessionToken)
      assert.equal(status, 200)
      assert.equal(data.data.status, 'active')

      const { data: m } = await supabaseAdmin.from('club_members')
        .select('status').eq('club_id', club.id).eq('user_id', joiner.user.id).single()
      assert.equal(m.status, 'active')
    } finally {
      if (club) await cleanupClub(club.id)
      await cleanupUser(owner.user.id); await cleanupUser(joiner.user.id)
    }
  })
})
