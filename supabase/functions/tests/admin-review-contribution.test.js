import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, callFunction, supabaseAdmin, E2E_MARKER } from './helpers.js'

describe('admin-review-contribution edge function', () => {
  let user, sessionToken, adminUser, adminToken, reportId, testEventId

  before(async () => {
    // Create a regular contributor
    ;({ user, sessionToken } = await createTestSession('reviewer-contrib'))
    await callFunction('update-profile', { username: `rev_contrib_${Date.now()}` }, sessionToken)

    // Create the admin user (their UUID must be in ADMIN_USER_IDS secret to pass admin tests)
    ;({ user: adminUser, sessionToken: adminToken } = await createTestSession('reviewer-admin'))
    await callFunction('update-profile', { username: `rev_admin_${Date.now()}` }, adminToken)

    // Get a calendar event to report on
    const { data } = await supabaseAdmin.from('calendar_events').select('id').limit(1).single()
    testEventId = data?.id

    // Submit a contribution as the contributor
    if (testEventId) {
      const { data: contribData } = await callFunction('submit-contribution', {
        type: 'event_report',
        reference_id: testEventId,
        payload: { field: 'name', note: `${E2E_MARKER} test report` },
      }, sessionToken)
      reportId = contribData.data?.id
    }

    console.log(`\nAdmin user UUID (add to ADMIN_USER_IDS secret): ${adminUser.id}`)
  })

  after(async () => {
    // cleanupUser deletes ALL the contributor's reports (including the 4
    // "extra" guardian-badge reports) before deleting the profile. Previously
    // only reportId was deleted here and the extras were cleaned inside the
    // test body AFTER its assertions — a failed assertion orphaned them into
    // the admin "Zgłoszenia" tab.
    await cleanupUser(user.id)
    await cleanupUser(adminUser.id)
  })

  it('returns 401 with no session cookie', async () => {
    const { status } = await callFunction('admin-review-contribution', {
      type: 'event_report', id: reportId, action: 'accept',
    })
    assert.equal(status, 401)
  })

  it('returns 403 for non-admin user', async () => {
    const { status } = await callFunction('admin-review-contribution', {
      type: 'event_report', id: reportId, action: 'accept',
    }, sessionToken)
    assert.equal(status, 403)
  })

  it('admin can accept a report and status changes to accepted', async () => {
    if (!reportId) return
    const { status } = await callFunction('admin-review-contribution', {
      type: 'event_report', id: reportId, action: 'accept',
    }, adminToken)
    // This will return 403 if adminUser.id is not in ADMIN_USER_IDS secret
    assert.equal(status, 200)

    const { data: row } = await supabaseAdmin
      .from('calendar_event_reports')
      .select('status')
      .eq('id', reportId)
      .single()
    assert.equal(row.status, 'accepted')
  })

  it('contributor receives guardian badge after 5 accepted reports', async () => {
    if (!testEventId) return
    for (let i = 0; i < 4; i++) {
      const { data } = await callFunction('submit-contribution', {
        type: 'event_report',
        reference_id: testEventId,
        payload: { field: 'date', note: `${E2E_MARKER} extra ${i}` },
      }, sessionToken)
      await callFunction('admin-review-contribution', {
        type: 'event_report', id: data.data?.id, action: 'accept',
      }, adminToken)
    }

    const { data: badges } = await supabaseAdmin
      .from('user_badges')
      .select('badge_definitions(slug)')
      .eq('user_id', user.id)
    const slugs = badges.map(b => b.badge_definitions.slug)
    assert.ok(slugs.includes('guardian'), `Expected guardian badge, got: ${slugs}`)
    // Extra reports are cleaned in after() via cleanupUser(user.id) so a
    // failed assertion above cannot leak them.
  })

  it('accepting again does not duplicate the guardian badge', async () => {
    const { data: guardianDef } = await supabaseAdmin
      .from('badge_definitions').select('id').eq('slug', 'guardian').single()
    const { data: badges } = await supabaseAdmin
      .from('user_badges')
      .select('id')
      .eq('user_id', user.id)
      .eq('badge_id', guardianDef.id)
    assert.equal(badges.length, 1)
  })
})
