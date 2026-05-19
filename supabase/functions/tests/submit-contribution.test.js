import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, callFunction, supabaseAdmin } from './helpers.js'

describe('submit-contribution edge function', () => {
  let user, accessToken, testEventId

  before(async () => {
    ;({ user, accessToken } = await createTestSession('contrib'))

    // Create a test profile (required for badge checks)
    await callFunction('update-profile', { username: `contrib_${Date.now()}` }, accessToken)

    // Get any existing calendar event to use as reference
    const { data } = await supabaseAdmin.from('calendar_events').select('id').limit(1).single()
    testEventId = data?.id
  })

  after(async () => {
    await supabaseAdmin.from('calendar_event_reports').delete().eq('user_id', user.id)
    await cleanupUser(user.id)
  })

  it('anon submission works (no Authorization header)', async () => {
    if (!testEventId) return
    const { status, data } = await callFunction('submit-contribution', {
      type: 'event_report',
      reference_id: testEventId,
      payload: { field: 'date', note: 'test anon report' },
    })
    assert.equal(status, 200)
    assert.ok(data.data.id)

    // Verify user_id is null for anon
    const { data: row } = await supabaseAdmin
      .from('calendar_event_reports')
      .select('user_id')
      .eq('id', data.data.id)
      .single()
    assert.equal(row.user_id, null)

    // Cleanup
    await supabaseAdmin.from('calendar_event_reports').delete().eq('id', data.data.id)
  })

  it('authenticated submission sets user_id', async () => {
    if (!testEventId) return
    const { status, data } = await callFunction('submit-contribution', {
      type: 'event_report',
      reference_id: testEventId,
      payload: { field: 'date', note: 'wrong date' },
    }, accessToken)
    assert.equal(status, 200)

    const { data: row } = await supabaseAdmin
      .from('calendar_event_reports')
      .select('user_id')
      .eq('id', data.data.id)
      .single()
    assert.equal(row.user_id, user.id)
  })

  it('first authenticated submission awards pioneer badge', async () => {
    const { data: badges } = await supabaseAdmin
      .from('user_badges')
      .select('badge_id, badge_definitions(slug)')
      .eq('user_id', user.id)
    const slugs = badges.map(b => b.badge_definitions.slug)
    assert.ok(slugs.includes('pioneer'), `Expected pioneer badge, got: ${slugs}`)
  })

  it('returns 400 for invalid contribution type', async () => {
    const { status } = await callFunction('submit-contribution', {
      type: 'invalid_type',
      payload: {},
    }, accessToken)
    assert.equal(status, 400)
  })

  it('general_feedback submission works', async () => {
    const { status, data } = await callFunction('submit-contribution', {
      type: 'general_feedback',
      payload: { category: 'bug', message: 'Something is broken' },
    }, accessToken)
    assert.equal(status, 200)
    assert.ok(data.data.id)
  })
})
