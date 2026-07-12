import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { supabaseAdmin, FUNCTIONS_URL } from './helpers.js'
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

describe('log-consent', () => {
  let sessionToken, userId

  before(async () => {
    // Create a real auth.users row so consent_log FK is satisfied
    const email = `test-log-consent-${Date.now()}@test.leszy.run`
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
    })
    if (authError) throw authError
    userId = authData.user.id

    // Seed a profile (mirrors what auth-verify-code does in production)
    await supabaseAdmin.from('profiles').insert({ id: userId, email })

    // Create a session token
    sessionToken = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const { error: sessionError } = await supabaseAdmin
      .from('auth_sessions')
      .insert({ id: sessionToken, user_id: userId, email, expires_at: expiresAt })
    if (sessionError) throw sessionError
  })

  after(async () => {
    await supabaseAdmin.from('consent_log').delete().eq('user_id', userId)
    await supabaseAdmin.from('auth_sessions').delete().eq('user_id', userId)
    await supabaseAdmin.from('profiles').delete().eq('id', userId)
    await supabaseAdmin.auth.admin.deleteUser(userId)
  })

  it('returns 401 for anonymous request (no session cookie)', async () => {
    const { status } = await post('log-consent', {
      decision: 'accepted',
      policyVersion: '1.0',
    })
    assert.equal(status, 401)
  })

  it('inserts a row in consent_log for authenticated request', async () => {
    const { status, data } = await post(
      'log-consent',
      { decision: 'accepted', policyVersion: '1.0' },
      sessionToken,
    )
    assert.equal(status, 200)
    assert.equal(data.logged, true)

    // Verify row was actually inserted (use service role to bypass RLS)
    const { data: rows, error } = await supabaseAdmin
      .from('consent_log')
      .select('user_id, decision, policy_version')
      .eq('user_id', userId)
      .eq('decision', 'accepted')
      .eq('policy_version', '1.0')
    assert.equal(error, null)
    assert.ok(rows.length >= 1)
    assert.equal(rows[0].user_id, userId)
    assert.equal(rows[0].decision, 'accepted')
    assert.equal(rows[0].policy_version, '1.0')
  })

  it('returns 400 for invalid decision string', async () => {
    const { status } = await post(
      'log-consent',
      { decision: 'maybe', policyVersion: '1.0' },
      sessionToken,
    )
    assert.equal(status, 400)
  })

  it('returns 400 when policyVersion is missing', async () => {
    const { status } = await post(
      'log-consent',
      { decision: 'accepted' },
      sessionToken,
    )
    assert.equal(status, 400)
  })
})
