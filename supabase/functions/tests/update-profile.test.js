import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, cleanupClub, callFunction, supabaseAdmin } from './helpers.js'

describe('update-profile edge function', () => {
  let user, sessionToken
  let clubId

  before(async () => {
    ;({ user, sessionToken } = await createTestSession('profile'))
  })

  after(async () => {
    await cleanupClub(clubId)
    await cleanupUser(user.id)
  })

  it('rejects request without session cookie', async () => {
    const { status } = await callFunction('update-profile', { username: 'testuser' })
    assert.equal(status, 401)
  })

  it('sets username on first update (onboarding)', async () => {
    const { status, data } = await callFunction(
      'update-profile',
      { username: 'testuser_plan', display_name: 'Test User' },
      sessionToken
    )
    assert.equal(status, 200)
    assert.equal(data.data.username, 'testuser_plan')
  })

  // Club identity is now managed exclusively via create-club / request-join /
  // respond-join / manage-member — update-profile must silently ignore any
  // club / club_id fields in the body (see clubs-lifecycle.test.js
  // 'update-profile clubs changes' for the primary coverage of this rule).
  it('ignores club and club_id in the body (removed free-text path)', async () => {
    const { status, data } = await callFunction(
      'update-profile',
      { club: 'Should Be Ignored', club_id: '00000000-0000-0000-0000-000000000000' },
      sessionToken
    )
    assert.equal(status, 200)
    assert.equal(data.data.club_id, null)
    assert.equal(data.data.club, null)
  })

  it('returns 409 if username is already taken', async () => {
    const { user: user2, sessionToken: token2 } = await createTestSession('profile2')
    try {
      const { status, data } = await callFunction('update-profile', { username: 'testuser_plan' }, token2)
      assert.equal(status, 409)
      assert.match(data.error, /already taken/i)
    } finally {
      await cleanupUser(user2.id)
    }
  })

  it('returns 400 for invalid username format', async () => {
    const { status } = await callFunction('update-profile', { username: 'Bad Username!' }, sessionToken)
    assert.equal(status, 400)
  })

  it('updates an existing profile', async () => {
    const { status, data } = await callFunction('update-profile', { display_name: 'Updated Name' }, sessionToken)
    assert.equal(status, 200)
    assert.equal(data.data.display_name, 'Updated Name')
  })

  it('privacy_settings change is reflected in profiles_public view (club joined via create-club)', async () => {
    const created = await callFunction('create-club', { name: `Klub Testowy Płock ${Date.now()}` }, sessionToken)
    assert.equal(created.status, 200, `create-club failed: ${JSON.stringify(created.data)}`)
    clubId = created.data.data.club.id

    await callFunction('update-profile', { privacy_settings: { display_name: true, club: false, bio: true } }, sessionToken)

    const { data: rows } = await supabaseAdmin
      .from('profiles_public')
      .select('club, username')
      .eq('username', 'testuser_plan')
      .single()

    assert.equal(rows.club, null)
    assert.equal(rows.username, 'testuser_plan')
  })

  it('accepts weekly_digest boolean and rejects non-boolean', async () => {
    const { user, sessionToken } = await createTestSession('digest')
    try {
      const ok = await callFunction('update-profile', { weekly_digest: true }, sessionToken)
      assert.equal(ok.status, 200)
      assert.equal(ok.data.data.weekly_digest, true)

      const bad = await callFunction('update-profile', { weekly_digest: 'yes' }, sessionToken)
      assert.equal(bad.status, 400)
    } finally {
      await cleanupUser(user.id)
    }
  })
})
