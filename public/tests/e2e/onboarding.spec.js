import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser } from './helpers.js'

test.describe('Onboarding flow', () => {
  let testUser

  test.beforeEach(async () => {
    testUser = await createTestUser('onboard')
  })

  test.afterEach(async () => {
    await cleanupUser(testUser.user.id)
  })

  async function loginAndGoToOnboarding(page) {
    await page.goto(testUser.magicLinkUrl)
    await page.waitForURL('/onboarding', { timeout: 15_000 })
  }

  test('onboarding page shows username field', async ({ page }) => {
    await loginAndGoToOnboarding(page)
    await expect(page.getByRole('heading', { name: /ustaw.*profil/i })).toBeVisible()
    await expect(page.getByLabel(/nazwa użytkownika/i)).toBeVisible()
  })

  test('submitting a valid username creates profile and redirects to /profil', async ({ page }) => {
    await loginAndGoToOnboarding(page)
    const handle = `tst_${Date.now()}`.toLowerCase().slice(0, 28)
    await page.getByLabel(/nazwa użytkownika/i).fill(handle)
    await page.getByRole('button', { name: /zapisz/i }).click()
    await expect(page).toHaveURL('/profil', { timeout: 15_000 })
  })

  test('invalid username format shows error and does not navigate', async ({ page }) => {
    await loginAndGoToOnboarding(page)
    await page.getByLabel(/nazwa użytkownika/i).fill('AB')
    await page.getByRole('button', { name: /zapisz/i }).click()
    await expect(page.getByText(/co najmniej 3/i)).toBeVisible()
    await expect(page).toHaveURL('/onboarding')
  })

  test('display name and club are optional — onboarding works without them', async ({ page }) => {
    await loginAndGoToOnboarding(page)
    const handle = `min_${Date.now()}`.toLowerCase().slice(0, 28)
    await page.getByLabel(/nazwa użytkownika/i).fill(handle)
    // Do NOT fill display_name or club
    await page.getByRole('button', { name: /zapisz/i }).click()
    await expect(page).toHaveURL('/profil', { timeout: 15_000 })
  })
})
