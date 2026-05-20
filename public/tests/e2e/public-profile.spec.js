import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser, supabaseAdmin, FUNCTIONS_URL } from './helpers.js'

async function setupUserWithProfile(suffix) {
  const testUser = await createTestUser(suffix)
  const username = `pub_${suffix}_${Date.now()}`.toLowerCase().slice(0, 28)
  await fetch(`${FUNCTIONS_URL}/update-profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `leszy_session=${testUser.sessionToken}` },
    body: JSON.stringify({ username, display_name: 'Test Display' }),
  })
  return { testUser, username }
}

test.describe('Public profile /u/:username', () => {
  let setup

  test.beforeAll(async () => {
    setup = await setupUserWithProfile('pubprofile')
  })

  test.afterAll(async () => {
    await cleanupUser(setup.testUser.user.id)
  })

  test('public profile page renders for existing user', async ({ page }) => {
    await page.goto(`/u/${setup.username}`)
    await expect(page.getByText(`@${setup.username}`)).toBeVisible()
  })

  test('display name is visible when privacy is on (default)', async ({ page }) => {
    await page.goto(`/u/${setup.username}`)
    await expect(page.getByText('Test Display')).toBeVisible()
  })

  test('display name is hidden when user sets privacy off', async ({ page }) => {
    await fetch(`${FUNCTIONS_URL}/update-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `leszy_session=${setup.testUser.sessionToken}` },
      body: JSON.stringify({ privacy_settings: { display_name: false, club: true } }),
    })
    await page.goto(`/u/${setup.username}`)
    await expect(page.getByText('Test Display')).not.toBeVisible()
  })

  test('404 page shown for non-existent username', async ({ page }) => {
    await page.goto('/u/this_user_does_not_exist_xyz123')
    await expect(page.getByText(/nie znaleziono/i)).toBeVisible()
  })

  test('badges section visible when user has badges', async ({ page }) => {
    const { data: badgeDef } = await supabaseAdmin
      .from('badge_definitions').select('id').limit(1).single()
    await supabaseAdmin
      .from('user_badges')
      .insert({ user_id: setup.testUser.user.id, badge_id: badgeDef.id })
    await page.goto(`/u/${setup.username}`)
    await expect(page.getByTestId('badges-section')).toBeVisible()
    await supabaseAdmin.from('user_badges').delete().eq('user_id', setup.testUser.user.id)
  })
})
