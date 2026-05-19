import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, callFunction, supabaseAdmin } from './helpers.js'

describe('update-profile edge function', () => {
  let user, accessToken

  before(async () => {
    ;({ user, accessToken } = await createTestSession('profile'))
  })

  after(async () => {
    await cleanupUser(user.id)
  })

  it('rejects request without Authorization header', async () => {
    const { status } = await callFunction('update-profile', { username: 'testuser' })
    assert.equal(status, 401)
  })

  it('creates a new profile on first call (onboarding)', async () => {
    const { status, data } = await callFunction(
      'update-profile',
      { username: 'testuser_plan', display_name: 'Test User', club: 'Klub Biegacza' },
      accessToken
    )
    assert.equal(status, 200)
    assert.equal(data.data.username, 'testuser_plan')
    assert.equal(data.data.club, 'Klub Biegacza')
  })

  it('returns 409 if username is already taken', async () => {
    // Create a second user to try the taken username
    const { user: user2, accessToken: token2 } = await createTestSession('profile2')
    try {
      const { status, data } = await callFunction(
        'update-profile',
        { username: 'testuser_plan' },
        token2
      )
      assert.equal(status, 409)
      assert.match(data.error, /already taken/i)
    } finally {
      await cleanupUser(user2.id)
    }
  })

  it('returns 400 for invalid username format', async () => {
    const { status } = await callFunction(
      'update-profile',
      { username: 'Bad Username!' },
      accessToken
    )
    assert.equal(status, 400)
  })

  it('updates an existing profile', async () => {
    const { status, data } = await callFunction(
      'update-profile',
      { display_name: 'Updated Name' },
      accessToken
    )
    assert.equal(status, 200)
    assert.equal(data.data.display_name, 'Updated Name')
  })

  it('privacy_settings change is reflected in profiles_public view', async () => {
    await callFunction('update-profile', { privacy_settings: { display_name: true, club: false, bio: true } }, accessToken)

    const { data: rows } = await supabaseAdmin
      .from('profiles_public')
      .select('club, username')
      .eq('username', 'testuser_plan')
      .single()

    assert.equal(rows.club, null)
    assert.equal(rows.username, 'testuser_plan')
  })

  it('awards club badge when club is set for the first time', async () => {
    const { data: badges } = await supabaseAdmin
      .from('user_badges')
      .select('badge_id, badge_definitions(slug)')
      .eq('user_id', user.id)

    const slugs = badges.map(b => b.badge_definitions.slug)
    assert.ok(slugs.includes('club'), `Expected club badge, got: ${slugs}`)
  })
})
