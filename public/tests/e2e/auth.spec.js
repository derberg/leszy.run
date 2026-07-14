import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser } from './helpers.js'

test.describe('Login page', () => {
  test('shows email form on /login', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByLabel(/email/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /wyślij kod/i })).toBeVisible()
  })

  test('shows code input after submitting email', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel(/email/i).fill('test@test.leszy.run')
    await page.getByRole('button', { name: /wyślij kod/i }).click()
    // Function returns 200 (honeypot path or real), step changes to 'code'
    await expect(page.getByLabel(/kod/i)).toBeVisible({ timeout: 8000 })
  })

  test('redirects to /profil when already logged in', async ({ page, context }) => {
    const testUser = await createTestUser('auth-redirect')
    // Set username so redirect goes to /profil not /onboarding
    await import('./helpers.js').then(h =>
      h.supabaseAdmin.from('profiles').update({ username: 'auth_redirect_user' }).eq('id', testUser.user.id)
    )
    await testUser.injectSession(context)
    await page.goto('/login')
    await page.waitForURL(/\/profil/)
    await cleanupUser(testUser.user.id)
  })

  test('redirects to /onboarding when logged in without username', async ({ page, context }) => {
    const testUser = await createTestUser('auth-onboarding')
    await testUser.injectSession(context)
    await page.goto('/login')
    await page.waitForURL('/onboarding')
    await cleanupUser(testUser.user.id)
  })
})
