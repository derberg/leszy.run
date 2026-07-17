import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser, supabaseAdmin, FUNCTIONS_URL } from './helpers.js'

test.describe('Profil page', () => {
  let testUser, profileUsername

  test.beforeAll(async () => {
    testUser = await createTestUser('profile')
    profileUsername = `profile_e2e_${Date.now()}`.toLowerCase().slice(0, 28)
    await fetch(`${FUNCTIONS_URL}/update-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `leszy_session=${testUser.sessionToken}` },
      body: JSON.stringify({ username: profileUsername }),
    })
  })

  test.afterAll(async () => {
    await cleanupUser(testUser.user.id)
  })

  test('shows profil page with username', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/profil')
    await expect(page.getByTestId('profil-page')).toBeVisible()
    await expect(page.getByText(`@${profileUsername}`)).toBeVisible()
  })

  test('shows empty contributions state', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/profil/zgloszenia')
    await expect(page.getByText(/brak zgłoszeń/i)).toBeVisible()
  })

  test('can edit display_name', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/profil/ustawienia')
    await page.getByTestId('edit-display_name').click({ force: true })
    await page.getByTestId('input-display_name').fill('Jan Testowy')
    await page.getByTestId('save-display_name').click()
    await expect(page.getByText('Jan Testowy')).toBeVisible()
  })

  // Club membership is no longer edited from Ustawienia (the old free-text
  // ClubInput + find_or_create_club pinning) — Ustawienia now shows a
  // read-only club name and links out to /profil/klub, where the full
  // create/join/manage flow lives (see clubs.spec.js for that coverage).
  test('shows read-only club row with a link to /profil/klub', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/profil/ustawienia')
    await expect(page.getByText(/brak klubu/i)).toBeVisible()
    await page.getByTestId('link-manage-club').click()
    await page.waitForURL(/\/profil\/klub/)
  })

  test('AuthGuard redirects to /login when not logged in', async ({ page }) => {
    await page.goto('/profil')
    await page.waitForURL('/login')
  })

  test('shows badges section when user has badges', async ({ page, context }) => {
    const { data: badgeDef } = await supabaseAdmin
      .from('badge_definitions')
      .select('id')
      .limit(1)
      .single()
    await supabaseAdmin
      .from('user_badges')
      .insert({ user_id: testUser.user.id, badge_id: badgeDef.id })
    await testUser.injectSession(context)
    await page.goto('/profil')
    await expect(page.getByTestId('badges-section')).toBeVisible()
    await supabaseAdmin.from('user_badges').delete().eq('user_id', testUser.user.id)
  })
})
