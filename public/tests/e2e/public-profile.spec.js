import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser, supabaseAdmin } from './helpers.js'

async function setupUserWithProfile(suffix) {
  const { user, magicLinkUrl, accessToken } = await createTestUser(suffix)
  const res = await fetch(`${process.env.VITE_SUPABASE_URL}/functions/v1/update-profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      username: `pub_${suffix}_${Date.now()}`.toLowerCase().slice(0, 28),
      display_name: 'Piotr Kowalski',
      club: 'KB Kraków',
    }),
  })
  const { data: profile } = await res.json()
  return { user, profile, accessToken }
}

test.describe('Public profile /u/:username', () => {
  let testUser

  test.beforeEach(async () => {
    testUser = await setupUserWithProfile('pubprof')
  })

  test.afterEach(async () => {
    await cleanupUser(testUser.user.id)
  })

  test('public profile page renders for existing user', async ({ page }) => {
    await page.goto(`/u/${testUser.profile.username}`)
    await expect(page.getByText(`@${testUser.profile.username}`)).toBeVisible()
  })

  test('display name is visible when privacy is on', async ({ page }) => {
    await page.goto(`/u/${testUser.profile.username}`)
    await expect(page.getByText('Piotr Kowalski')).toBeVisible()
  })

  test('display name is hidden when user sets privacy off', async ({ page }) => {
    await fetch(`${process.env.VITE_SUPABASE_URL}/functions/v1/update-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${testUser.accessToken}` },
      body: JSON.stringify({ privacy_settings: { display_name: false, club: true, bio: true } }),
    })
    await page.goto(`/u/${testUser.profile.username}`)
    await expect(page.getByText('Piotr Kowalski')).not.toBeVisible()
    await expect(page.getByText(`@${testUser.profile.username}`)).toBeVisible()
  })

  test('404 page shown for non-existent username', async ({ page }) => {
    await page.goto('/u/this_user_does_not_exist_xyz_999')
    await expect(page.getByText(/nie znaleziono/i)).toBeVisible()
  })

  test('badges section visible when user has badges', async ({ page }) => {
    const { data: events } = await supabaseAdmin.from('calendar_events').select('id').limit(1).single()
    if (events?.id) {
      await fetch(`${process.env.VITE_SUPABASE_URL}/functions/v1/submit-contribution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${testUser.accessToken}` },
        body: JSON.stringify({
          type: 'event_report',
          reference_id: events.id,
          payload: { field: 'name', note: 'test' },
        }),
      })
    }
    await page.goto(`/u/${testUser.profile.username}`)
    // Pioneer badge icon ★ should appear after first contribution
    await expect(page.getByText('★')).toBeVisible({ timeout: 10_000 })
  })
})
