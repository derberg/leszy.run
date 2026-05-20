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
