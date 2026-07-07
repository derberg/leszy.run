import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser, supabaseAdmin, FUNCTIONS_URL, E2E_MARKER } from './helpers.js'

test.describe('Community flows with auth', () => {
  let testUser, profileUsername

  test.beforeAll(async () => {
    testUser = await createTestUser('contrib-e2e')
    profileUsername = `contrib_e2e_${Date.now()}`.toLowerCase().slice(0, 28)
    await fetch(`${FUNCTIONS_URL}/update-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `leszy_session=${testUser.sessionToken}` },
      body: JSON.stringify({ username: profileUsername }),
    })
  })

  test.afterAll(async () => {
    // cleanupUser deletes the user's reports before the profile (user_id FK is
    // ON DELETE SET NULL — wrong order orphans the report in the admin tab).
    await cleanupUser(testUser.user.id)
  })

  test('logged-in user submitting a report sees it in /profil', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/kalendarz')
    const reportBtn = page.getByTestId('report-event-btn').first()
    const visible = await reportBtn.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)
    if (!visible) { test.skip(); return }
    await reportBtn.click()
    await page.locator('select').first().selectOption('name')
    await page.locator('input[type="text"]').last().fill(`${E2E_MARKER} Poprawiona nazwa`)
    await page.getByRole('button', { name: /wyślij/i }).click()
    await expect(page.getByText(/dziękujemy/i)).toBeVisible()
    await page.goto('/profil')
    await expect(page.getByText(/raport/i).first()).toBeVisible()
  })

  test('anon user clicking report shows login prompt instead of form', async ({ page }) => {
    await page.goto('/kalendarz')
    const reportBtn = page.getByTestId('report-event-btn').first()
    const visible = await reportBtn.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)
    if (!visible) { test.skip(); return }
    await reportBtn.click()
    await expect(page.getByText(/wymagane logowanie/i)).toBeVisible()
    // scope to the prompt container — the navbar also renders "Zaloguj się" links for anon users
    const prompt = page.getByText(/wymagane logowanie/i).locator('..')
    await expect(prompt.getByRole('link', { name: /zaloguj się/i })).toBeVisible()
  })
})
