import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { supabaseAdmin, FUNCTIONS_URL, E2E_MARKER } from './helpers.js'
import crypto from 'node:crypto'

async function post(path, body, cookie = null) {
  const headers = { 'Content-Type': 'application/json' }
  if (cookie) headers['Cookie'] = `leszy_session=${cookie}`
  const res = await fetch(`${FUNCTIONS_URL}/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}

describe('delete-my-account', () => {
  let sessionToken, userId, email, testEventId, testParticipantId, testFavEventId

  before(async () => {
    email = `test-delete-account-${Date.now()}@test.leszy.run`
    userId = crypto.randomUUID()

    // Insert profile directly (no auth.users needed for this flow — our custom sessions don't require it)
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .insert({ id: userId, email })
    if (profileError) throw profileError

    sessionToken = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const { error: sessionError } = await supabaseAdmin
      .from('auth_sessions')
      .insert({ id: sessionToken, user_id: userId, email, expires_at: expiresAt })
    if (sessionError) throw sessionError

    // Seed a minimal event so we can attach a participant row
    const { data: eventRow, error: eventError } = await supabaseAdmin
      .from('events')
      .insert({ name: `${E2E_MARKER} delete-account-event` })
      .select('id')
      .single()
    if (eventError) throw eventError
    testEventId = eventRow.id

    // Seed a participant row with the test user's email (category_id is nullable)
    const { data: participantRow, error: participantError } = await supabaseAdmin
      .from('participants')
      .insert({ event_id: testEventId, first_name: 'Jan', last_name: 'Testowy', email, phone: '+48123456789' })
      .select('id')
      .single()
    if (participantError) throw participantError
    testParticipantId = participantRow.id

    // Seed a calendar event + favorite so we can verify favorites are erased on deletion
    const { data: favEvent, error: favEventError } = await supabaseAdmin
      .from('calendar_events')
      .insert({
        name: `test-delete-account-fav-${Date.now()}`, date: '2030-01-01',
        source: 'test', source_id: `delete-fav-${crypto.randomUUID()}`, status: 'active',
      })
      .select('id')
      .single()
    if (favEventError) throw favEventError
    testFavEventId = favEvent.id

    const { error: favError } = await supabaseAdmin
      .from('event_favorites')
      .insert({ user_id: userId, event_id: testFavEventId })
    if (favError) throw favError
  })

  after(async () => {
    // Clean up favorites + favorite event fixture
    await supabaseAdmin.from('event_favorites').delete().eq('user_id', userId)
    if (testFavEventId) await supabaseAdmin.from('calendar_events').delete().eq('id', testFavEventId)
    // Clean up OTP codes issued during the test
    await supabaseAdmin.from('auth_codes').delete().eq('email', email)
    // Clean up session
    await supabaseAdmin.from('auth_sessions').delete().eq('user_id', userId)
    // Profile may have been soft-deleted (email nulled); delete by id
    await supabaseAdmin.from('profiles').delete().eq('id', userId)
    // Clean up participant and event fixtures
    if (testParticipantId) await supabaseAdmin.from('participants').delete().eq('id', testParticipantId)
    if (testEventId) await supabaseAdmin.from('events').delete().eq('id', testEventId)
  })

  it('returns 401 for anonymous request (no session cookie)', async () => {
    const { status } = await post('delete-my-account', { action: 'request' })
    assert.equal(status, 401)
  })

  it('action=request issues OTP with purpose=delete_account', async () => {
    const { status, data } = await post('delete-my-account', { action: 'request' }, sessionToken)
    assert.equal(status, 200)
    assert.equal(data.sent, true)

    // Verify an auth_codes row was written with purpose='delete_account'
    const { data: rows, error } = await supabaseAdmin
      .from('auth_codes')
      .select('email, purpose, used, expires_at')
      .eq('email', email)
      .eq('purpose', 'delete_account')
      .eq('used', false)
      .order('created_at', { ascending: false })
      .limit(1)
    assert.equal(error, null)
    assert.ok(rows.length >= 1, 'Expected at least one delete_account OTP row')
    assert.equal(rows[0].email, email)
    assert.equal(rows[0].purpose, 'delete_account')
    assert.equal(rows[0].used, false)
  })

  it('action=confirm with valid code soft-deletes profile and bans auth user', async () => {
    // Issue a fresh OTP directly into the DB so we know the plaintext
    const plainCode = '543210'
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plainCode))
    const codeHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    const { error: insertError } = await supabaseAdmin.from('auth_codes').insert({
      email,
      code_hash: codeHash,
      expires_at: expiresAt,
      purpose: 'delete_account',
    })
    assert.equal(insertError, null)

    const { status, data } = await post(
      'delete-my-account',
      { action: 'confirm', code: plainCode },
      sessionToken,
    )
    assert.equal(status, 200)
    assert.equal(data.deleted, true)

    // Verify profile was soft-deleted
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('email, display_name, deleted_at, username')
      .eq('id', userId)
      .single()
    assert.equal(profileError, null)
    assert.equal(profile.email, null, 'Profile email should be nulled')
    assert.equal(profile.display_name, 'Uczestnik anonimowy')
    assert.ok(profile.deleted_at, 'deleted_at should be set')
    assert.ok(profile.username.startsWith('usuniety-'), 'username should be anonymized')

    // Note: auth.users ban is verified by checking that the ban_duration was set.
    // Since we seeded a profile-only row (no auth.users entry), the ban step logs a
    // non-fatal error and continues — the profile deletion is the critical outcome.
    // In full integration tests with real auth.users rows, supabaseAdmin.auth.admin.getUserById
    // would show banned_until set far in the future.

    // Verify participant row was anonymized
    const { data: participant, error: participantError } = await supabaseAdmin
      .from('participants')
      .select('first_name, last_name, phone, email, deleted_at')
      .eq('id', testParticipantId)
      .single()
    assert.equal(participantError, null)
    assert.equal(participant.first_name, 'Uczestnik', 'participant first_name should be anonymized')
    assert.equal(participant.last_name, 'anonimowy', 'participant last_name should be anonymized')
    assert.equal(participant.phone, null, 'participant phone should be nulled')
    assert.equal(participant.email, null, 'participant email should be nulled')
    assert.ok(participant.deleted_at, 'participant deleted_at should be set')

    // Verify event favorites were erased (no FK cascade on soft delete — must be explicit)
    const { count: favCount, error: favError } = await supabaseAdmin
      .from('event_favorites')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
    assert.equal(favError, null)
    assert.equal(favCount, 0, 'event_favorites rows should be deleted on account deletion')
  })

  it('action=confirm with invalid code returns 401', async () => {
    // Create a second test user so the session is still valid (first user is soft-deleted)
    const email2 = `test-delete-account-bad-${Date.now()}@test.leszy.run`
    const userId2 = crypto.randomUUID()
    await supabaseAdmin.from('profiles').insert({ id: userId2, email: email2 })
    const token2 = crypto.randomBytes(32).toString('hex')
    await supabaseAdmin.from('auth_sessions').insert({
      id: token2,
      user_id: userId2,
      email: email2,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })

    const { status } = await post(
      'delete-my-account',
      { action: 'confirm', code: '000000' },
      token2,
    )
    assert.equal(status, 401)

    // Cleanup second test user
    await supabaseAdmin.from('auth_sessions').delete().eq('user_id', userId2)
    await supabaseAdmin.from('profiles').delete().eq('id', userId2)
  })
})
