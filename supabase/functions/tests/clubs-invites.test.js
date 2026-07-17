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
