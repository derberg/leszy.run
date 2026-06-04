import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { supabaseAdmin, FUNCTIONS_URL, createTestSession, cleanupUser } from './helpers.js'

async function post(name, sessionToken = null) {
  const headers = { 'Content-Type': 'application/json' }
  if (sessionToken) headers['Cookie'] = `leszy_session=${sessionToken}`
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  })
  return res
}

describe('export-my-data', () => {
  let sessionToken, userId

  before(async () => {
    const session = await createTestSession('export-my-data')
    userId = session.user.id
    sessionToken = session.sessionToken

    // Seed a consent_log entry so we can verify it is exported
    const { error } = await supabaseAdmin.from('consent_log').insert({
      user_id: userId,
      decision: 'accepted',
      policy_version: '2026-06-04',
    })
    if (error) throw error
  })

  after(async () => {
    await supabaseAdmin.from('consent_log').delete().eq('user_id', userId)
    await supabaseAdmin.from('user_badges').delete().eq('user_id', userId)
    await cleanupUser(userId)
  })

  it('returns 401 for anonymous request (no session cookie)', async () => {
    const res = await post('export-my-data')
    assert.equal(res.status, 401)
  })

  it('returns 200 with user data for authenticated request', async () => {
    const res = await post('export-my-data', sessionToken)
    assert.equal(res.status, 200)

    const data = await res.json()

    assert.ok(data.exported_at, 'exported_at should be present')
    assert.ok(data.policy_version_at_export, 'policy_version_at_export should be present')
    assert.ok(data.account !== undefined, 'account field should be present')
    assert.equal(data.account.id, userId, 'account.id should match the authenticated user')
    assert.ok(Array.isArray(data.badges), 'badges should be an array')
    assert.ok(Array.isArray(data.consent_log), 'consent_log should be an array')
    assert.ok(data.consent_log.length >= 1, 'consent_log should contain the seeded entry')
    assert.equal(data.consent_log[0].user_id, userId)
  })

  it('sets Content-Disposition header with correct filename format', async () => {
    const res = await post('export-my-data', sessionToken)
    assert.equal(res.status, 200)

    const disposition = res.headers.get('content-disposition')
    assert.ok(disposition, 'content-disposition header should be present')

    const date = new Date().toISOString().slice(0, 10)
    const expected = `attachment; filename="leszy-run-dane-${userId}-${date}.json"`
    assert.equal(disposition, expected)
  })
})
