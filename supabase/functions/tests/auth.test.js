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
  return { status: res.status, data: await res.json(), headers: res.headers }
}

describe('auth-request-code', () => {
  after(async () => {
    await supabaseAdmin.from('auth_codes').delete().like('email', '%@test.leszy.run')
  })

  it('returns 200 silently when honeypot is filled', async () => {
    const { status, data } = await post('auth-request-code', {
      email: 'bot@test.leszy.run',
      honeypot: 'I am a bot',
    })
    assert.equal(status, 200)
    assert.equal(data.success, true)
    // Verify no code was stored
    const { data: codes } = await supabaseAdmin
      .from('auth_codes')
      .select('id')
      .eq('email', 'bot@test.leszy.run')
    assert.equal(codes.length, 0)
  })

  it('returns 400 for invalid email', async () => {
    const { status } = await post('auth-request-code', { email: 'notanemail' })
    assert.equal(status, 400)
  })

  it('stores a hashed code and returns success for valid email', async () => {
    const email = `req-code-${Date.now()}@test.leszy.run`
    const { status, data } = await post('auth-request-code', { email })
    assert.equal(status, 200)
    assert.equal(data.success, true)

    const { data: codes } = await supabaseAdmin
      .from('auth_codes')
      .select('code_hash, used, attempts')
      .eq('email', email)
      .eq('used', false)
    assert.equal(codes.length, 1)
    assert.equal(codes[0].used, false)
    assert.equal(codes[0].attempts, 0)
    assert.ok(codes[0].code_hash.length === 64) // sha256 hex
  })

  it('invalidates previous unused codes when a new one is requested', async () => {
    const email = `req-code-multi-${Date.now()}@test.leszy.run`
    await post('auth-request-code', { email })
    await post('auth-request-code', { email })

    const { data: active } = await supabaseAdmin
      .from('auth_codes')
      .select('id')
      .eq('email', email)
      .eq('used', false)
    assert.equal(active.length, 1) // only the latest is active
  })
})

describe('auth-verify-code', () => {
  const email = `verify-${Date.now()}@test.leszy.run`

  async function seedCode(overrides = {}) {
    const code = '123456'
    const hash = crypto.createHash('sha256').update(code).digest('hex')
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    await supabaseAdmin.from('auth_codes').insert({
      email,
      code_hash: hash,
      expires_at: overrides.expiresAt ?? expiresAt,
      attempts: overrides.attempts ?? 0,
      used: overrides.used ?? false,
    })
    return code
  }

  after(async () => {
    await supabaseAdmin.from('auth_sessions').delete().eq('email', email)
    await supabaseAdmin.from('profiles').delete().eq('email', email)
    await supabaseAdmin.from('auth_codes').delete().eq('email', email)
  })

  it('returns 400 for expired code', async () => {
    await seedCode({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    const { status } = await post('auth-verify-code', { email, code: '123456' })
    assert.equal(status, 400)
  })

  it('returns 401 for wrong code', async () => {
    await seedCode()
    const { status } = await post('auth-verify-code', { email, code: '000000' })
    assert.equal(status, 401)
  })

  it('returns 403 after 3 failed attempts', async () => {
    await seedCode({ attempts: 3 })
    const { status } = await post('auth-verify-code', { email, code: '123456' })
    assert.equal(status, 403)
  })

  it('returns 200 with Set-Cookie on correct code, creates profile and session', async () => {
    await seedCode()
    const { status, data, headers } = await post('auth-verify-code', { email, code: '123456' })
    assert.equal(status, 200)
    assert.equal(data.success, true)
    assert.equal(typeof data.hasUsername, 'boolean')

    const setCookie = headers.get('set-cookie')
    assert.ok(setCookie?.includes('leszy_session='))
    assert.ok(setCookie?.includes('HttpOnly'))

    // Profile created
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, email')
      .eq('email', email)
      .single()
    assert.equal(profile.email, email)

    // Session created
    const token = setCookie.match(/leszy_session=([^;]+)/)[1]
    const { data: session } = await supabaseAdmin
      .from('auth_sessions')
      .select('user_id, email')
      .eq('id', token)
      .single()
    assert.equal(session.email, email)
  })

  it('returns hasUsername=true if profile already has username', async () => {
    // The previous test created the profile; update it with a username
    await supabaseAdmin
      .from('profiles')
      .update({ username: `verify_user_${Date.now()}`.slice(0, 30) })
      .eq('email', email)
    await seedCode()
    const { data } = await post('auth-verify-code', { email, code: '123456' })
    assert.equal(data.hasUsername, true)
  })
})

describe('auth-me', () => {
  let sessionToken
  const email = `me-${Date.now()}@test.leszy.run`

  before(async () => {
    const userId = crypto.randomUUID()
    await supabaseAdmin.from('profiles').insert({ id: userId, email, username: 'me_test_user' })
    sessionToken = crypto.randomBytes(32).toString('hex')
    await supabaseAdmin.from('auth_sessions').insert({
      id: sessionToken,
      user_id: userId,
      email,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
  })

  after(async () => {
    await supabaseAdmin.from('auth_sessions').delete().eq('email', email)
    await supabaseAdmin.from('profiles').delete().eq('email', email)
  })

  it('returns 401 with no cookie', async () => {
    const { status } = await post('auth-me', {})
    assert.equal(status, 401)
  })

  it('returns user data with valid cookie', async () => {
    const { status, data } = await post('auth-me', {}, sessionToken)
    assert.equal(status, 200)
    assert.equal(data.user.email, email)
    assert.equal(data.user.username, 'me_test_user')
  })
})

describe('auth-logout', () => {
  let sessionToken
  const email = `logout-${Date.now()}@test.leszy.run`

  before(async () => {
    const userId = crypto.randomUUID()
    await supabaseAdmin.from('profiles').insert({ id: userId, email })
    sessionToken = crypto.randomBytes(32).toString('hex')
    await supabaseAdmin.from('auth_sessions').insert({
      id: sessionToken,
      user_id: userId,
      email,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
  })

  after(async () => {
    await supabaseAdmin.from('profiles').delete().eq('email', email)
  })

  it('deletes session and clears cookie', async () => {
    const { status, headers } = await post('auth-logout', {}, sessionToken)
    assert.equal(status, 200)
    const setCookie = headers.get('set-cookie')
    assert.ok(setCookie?.includes('Max-Age=0'))

    const { data } = await supabaseAdmin
      .from('auth_sessions')
      .select('id')
      .eq('id', sessionToken)
    assert.equal(data.length, 0)
  })
})
