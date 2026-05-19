import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, callFunction, supabaseAdmin } from './helpers.js'

describe('admin-review-contribution edge function', () => {
  let user, accessToken, adminUser, adminToken, reportId, testEventId

  before(async () => {
    // Create a regular contributor
    ;({ user, accessToken } = await createTestSession('reviewer-contrib'))
    await callFunction('update-profile', { username: `rev_contrib_${Date.now()}` }, accessToken)

    // Create the admin user (their UUID must be in ADMIN_USER_IDS secret to pass admin tests)
    ;({ user: adminUser, accessToken: adminToken } = await createTestSession('reviewer-admin'))
    await callFunction('update-profile', { username: `rev_admin_${Date.now()}` }, adminToken)

    // Get a calendar event to report on
    const { data } = await supabaseAdmin.from('calendar_events').select('id').limit(1).single()
    testEventId = data?.id

    // Submit a contribution as the contributor
    if (testEventId) {
      const { data: contribData } = await callFunction('submit-contribution', {
        type: 'event_report',
        reference_id: testEventId,
        payload: { field: 'name', note: 'test report' },
      }, accessToken)
      reportId = contribData.data?.id
    }

    console.log(`\nAdmin user UUID (add to ADMIN_USER_IDS secret): ${adminUser.id}`)
  })

  after(async () => {
    if (reportId) await supabaseAdmin.from('calendar_event_reports').delete().eq('id', reportId)
    await cleanupUser(user.id)
    await cleanupUser(adminUser.id)
  })

  it('returns 401 with no Authorization header', async () => {
    const { status } = await callFunction('admin-review-contribution', {
      type: 'event_report', id: reportId, action: 'accept',
    })
    assert.equal(status, 401)
  })

  it('returns 403 for non-admin user', async () => {
    const { status } = await callFunction('admin-review-contribution', {
      type: 'event_report', id: reportId, action: 'accept',
    }, accessToken)
    assert.equal(status, 403)
  })

  it('admin can accept a report and status changes to accepted', async () => {
    if (!reportId) return
    const { status } = await callFunction('admin-review-contribution', {
      type: 'event_report', id: reportId, action: 'accept',
    }, adminToken)
    // This will return 403 if adminUser.id is not in ADMIN_USER_IDS secret
    // Add adminUser.id to ADMIN_USER_IDS in Supabase dashboard to make this pass
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
    const extraIds = []
    for (let i = 0; i < 4; i++) {
      const { data } = await callFunction('submit-contribution', {
        type: 'event_report',
        reference_id: testEventId,
        payload: { field: 'date', note: `extra ${i}` },
      }, accessToken)
      extraIds.push(data.data?.id)
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

    for (const id of extraIds) {
      if (id) await supabaseAdmin.from('calendar_event_reports').delete().eq('id', id)
    }
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
