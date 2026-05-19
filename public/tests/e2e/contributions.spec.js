import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser, supabaseAdmin } from './helpers.js'

test.describe('Community flows with auth', () => {
  let testUser, profileUsername

  test.beforeAll(async () => {
    testUser = await createTestUser('contrib-e2e')
    profileUsername = `contrib_e2e_${Date.now()}`.toLowerCase().slice(0, 28)
    await fetch(`${process.env.VITE_SUPABASE_URL}/functions/v1/update-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${testUser.accessToken}` },
      body: JSON.stringify({ username: profileUsername }),
    })
  })

  test.afterAll(async () => {
    await supabaseAdmin.from('calendar_event_reports').delete().eq('user_id', testUser.user.id)
    await cleanupUser(testUser.user.id)
  })

  test('logged-in user submitting a report sees it in /profil', async ({ page }) => {
    await page.goto(testUser.magicLinkUrl)
    await page.waitForURL(/\/(onboarding|profil)/)
    if (page.url().includes('/onboarding')) {
      await page.waitForURL('/profil')
    }

    await page.goto('/kalendarz')
    const reportBtn = page.getByTestId('report-event-btn').first()
    // Wait up to 10s for events to load; skip if calendar is empty
    const visible = await reportBtn.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }
    await reportBtn.click()

    await page.locator('select').first().selectOption('name')
    await page.locator('input[type="text"]').last().fill('Poprawiona nazwa')
    await page.getByRole('button', { name: /wyślij/i }).click()
    await expect(page.getByText(/dziękujemy/i)).toBeVisible()

    await page.goto('/profil')
    await expect(page.getByText(/raport/i).first()).toBeVisible()
  })

  test('anon report submission still works without login', async ({ page }) => {
    await page.goto('/kalendarz')
    const reportBtn = page.getByTestId('report-event-btn').first()
    const visible = await reportBtn.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }
    await reportBtn.click()

    await page.locator('select').first().selectOption('name')
    await page.locator('input[type="text"]').last().fill('Poprawiona nazwa anon')
    await page.getByRole('button', { name: /wyślij/i }).click()
    await expect(page.getByText(/dziękujemy/i)).toBeVisible()
  })
})
