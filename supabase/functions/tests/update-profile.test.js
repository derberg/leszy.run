import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, callFunction, supabaseAdmin } from './helpers.js'

async function cleanupClub(name) {
  const { data } = await supabaseAdmin.rpc('normalize_club_name', { input: name })
  if (data) {
    await supabaseAdmin.from('clubs').delete().eq('normalized_name', data)
  } else {
    await supabaseAdmin.from('clubs').delete().ilike('name', name)
  }
}

describe('update-profile edge function', () => {
  let user, sessionToken
  const TS = Date.now() // single timestamp — both names MUST normalize identically
  const CLUB_A = `Klub Testowy Płock ${TS}`
  const CLUB_A_VARIANT = `klub testowy plock ${TS}` // same after normalization

  before(async () => {
    ;({ user, sessionToken } = await createTestSession('profile'))
  })

  after(async () => {
    await cleanupUser(user.id)
    await cleanupClub(CLUB_A)
  })

  it('rejects request without session cookie', async () => {
    const { status } = await callFunction('update-profile', { username: 'testuser' })
    assert.equal(status, 401)
  })

  it('sets username + free-text club on first update (onboarding)', async () => {
    const { status, data } = await callFunction(
      'update-profile',
      { username: 'testuser_plan', display_name: 'Test User', club: CLUB_A },
      sessionToken
    )
    assert.equal(status, 200)
    assert.equal(data.data.username, 'testuser_plan')
    assert.equal(data.data.club, CLUB_A.trim())   // name string still returned
    assert.ok(data.data.club_id)                   // FK now set
  })

  it('same club typed differently resolves to the SAME club_id', async () => {
    const { user: u2, sessionToken: t2 } = await createTestSession('profile_dup')
    try {
      const first = await callFunction('update-profile', { club: CLUB_A }, sessionToken)
      const second = await callFunction('update-profile', { club: CLUB_A_VARIANT }, t2)
      assert.equal(first.status, 200, `first call failed: ${JSON.stringify(first.data)}`)
      assert.equal(second.status, 200, `second call failed: ${JSON.stringify(second.data)}`)
      assert.equal(second.data.data.club_id, first.data.data.club_id)
      assert.equal(second.data.data.club, CLUB_A.trim()) // first writer's display form wins
    } finally {
      await cleanupUser(u2.id)
      await cleanupClub(CLUB_A_VARIANT)
    }
  })

  it('accepts club_id directly when it exists', async () => {
    const prof = await callFunction('update-profile', { club: CLUB_A }, sessionToken)
    assert.equal(prof.status, 200, `setup call failed: ${JSON.stringify(prof.data)}`)
    const { status, data } = await callFunction('update-profile', { club_id: prof.data.data.club_id }, sessionToken)
    assert.equal(status, 200)
    assert.equal(data.data.club_id, prof.data.data.club_id)
  })

  it('rejects unknown club_id with 400', async () => {
    const { status } = await callFunction(
      'update-profile',
      { club_id: '00000000-0000-0000-0000-000000000000' },
      sessionToken
    )
    assert.equal(status, 400)
  })

  it('rejects club that normalizes to empty with 400', async () => {
    const { status } = await callFunction('update-profile', { club: '---' }, sessionToken)
    assert.equal(status, 400)
  })

  it('clears club with empty string', async () => {
    const { status, data } = await callFunction('update-profile', { club: '' }, sessionToken)
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

  it('privacy_settings change is reflected in profiles_public view', async () => {
    await callFunction('update-profile', { club: CLUB_A }, sessionToken) // re-set club
    await callFunction('update-profile', { privacy_settings: { display_name: true, club: false, bio: true } }, sessionToken)

    const { data: rows } = await supabaseAdmin
      .from('profiles_public')
      .select('club, username')
      .eq('username', 'testuser_plan')
      .single()

    assert.equal(rows.club, null)
    assert.equal(rows.username, 'testuser_plan')
  })

  it('awards club badge when club is set', async () => {
    const { data: badges } = await supabaseAdmin
      .from('user_badges')
      .select('badge_id, badge_definitions(slug)')
      .eq('user_id', user.id)

    const slugs = badges.map(b => b.badge_definitions.slug)
    assert.ok(slugs.includes('club'), `Expected club badge, got: ${slugs}`)
  })
})
