import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser } from './helpers.js'

test.describe('Auth flow', () => {
  let testUser

  test.beforeEach(async () => {
    testUser = await createTestUser('auth')
  })

  test.afterEach(async () => {
    await cleanupUser(testUser.user.id)
  })

  test('login page renders and shows email form', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: /zaloguj/i })).toBeVisible()
    await expect(page.getByRole('textbox', { name: /email/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /wyślij kod/i })).toBeVisible()
  })

  test('redirect to /login when visiting /profil unauthenticated', async ({ page }) => {
    await page.goto('/profil')
    await expect(page).toHaveURL('/login')
  })

  test('magic link login navigates to /onboarding for new user', async ({ page }) => {
    await page.goto(testUser.magicLinkUrl)
    await page.waitForURL(/\/(onboarding|profil)/, { timeout: 15_000 })
    const url = page.url()
    // New user with no profile → onboarding; already profiled → profil
    expect(url).toMatch(/\/(onboarding|profil)/)
  })

  test('already-logged-in user visiting /login is redirected', async ({ page }) => {
    await page.goto(testUser.magicLinkUrl)
    await page.waitForURL(/\/(onboarding|profil)/, { timeout: 15_000 })
    await page.goto('/login')
    await page.waitForURL(/\/(profil|onboarding)/, { timeout: 10_000 })
    expect(page.url()).toMatch(/\/(profil|onboarding)/)
  })
})
