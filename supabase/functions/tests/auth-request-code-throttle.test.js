import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { supabaseAdmin, FUNCTIONS_URL } from './helpers.js'

async function requestCode(email) {
  const res = await fetch(`${FUNCTIONS_URL}/auth-request-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  return { status: res.status, headers: res.headers, data: await res.json() }
}

describe('auth-request-code throttle', () => {
  let testEmail
  const throttleKeys = []

  before(async () => {
    // Use a unique email that will never receive real mail
    testEmail = `throttle-test-${Date.now()}@invalid.test`
    throttleKeys.push(`email:${testEmail}`)
  })

  after(async () => {
    // Clean up otp_throttle rows created during the test
    for (const key of throttleKeys) {
      await supabaseAdmin.from('otp_throttle').delete().eq('key', key)
    }
    // Clean up any auth_codes rows inserted for the test email
    await supabaseAdmin.from('auth_codes').delete().eq('email', testEmail)
  })

  it('first 5 requests to the same email all succeed (200)', async () => {
    for (let i = 1; i <= 5; i++) {
      const { status } = await requestCode(testEmail)
      assert.equal(status, 200, `expected 200 on request #${i}, got ${status}`)
    }
  })

  it('6th request to the same email within 15 min returns 429 with retry-after header', async () => {
    const { status, headers } = await requestCode(testEmail)
    assert.equal(status, 429)
    const retryAfter = headers.get('retry-after')
    assert.ok(retryAfter !== null, 'expected retry-after header to be present')
    assert.ok(Number(retryAfter) > 0, `expected retry-after > 0, got ${retryAfter}`)
  })
})
