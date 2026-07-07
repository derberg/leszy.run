import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, callFunction, supabaseAdmin, E2E_MARKER } from './helpers.js'

describe('submit-contribution edge function', () => {
  let user, sessionToken, testEventId

  before(async () => {
    ;({ user, sessionToken } = await createTestSession('contrib'))

    // Create a test profile with username (required for badge checks on profile page)
    await callFunction('update-profile', { username: `contrib_${Date.now()}` }, sessionToken)

    // Get any existing calendar event to use as reference
    const { data } = await supabaseAdmin.from('calendar_events').select('id').limit(1).single()
    testEventId = data?.id
  })

  after(async () => {
    // cleanupUser deletes the user's reports, feedback, and badges before the
    // profile — including the general_feedback row this suite creates, which
    // previously leaked into the admin "Sugestie" tab on every run.
    await cleanupUser(user.id)
  })

  it('returns 401 for anonymous submission (no session cookie)', async () => {
    if (!testEventId) return
    const { status } = await callFunction('submit-contribution', {
      type: 'event_report',
      reference_id: testEventId,
      payload: { field: 'date', note: `${E2E_MARKER} test anon report` },
    })
    assert.equal(status, 401)
  })

  it('authenticated submission sets user_id', async () => {
    if (!testEventId) return
    const { status, data } = await callFunction('submit-contribution', {
      type: 'event_report',
      reference_id: testEventId,
      payload: { field: 'date', note: `${E2E_MARKER} wrong date` },
    }, sessionToken)
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
    }, sessionToken)
    assert.equal(status, 400)
  })

  it('general_feedback submission works', async () => {
    const { status, data } = await callFunction('submit-contribution', {
      type: 'general_feedback',
      payload: { category: 'bug', message: `${E2E_MARKER} Something is broken` },
    }, sessionToken)
    assert.equal(status, 200)
    assert.ok(data.data.id)
  })
})
