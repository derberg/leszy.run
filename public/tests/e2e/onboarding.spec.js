import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser, supabaseAdmin } from './helpers.js'

test.describe('Onboarding', () => {
  let testUser

  test.beforeEach(async () => {
    testUser = await createTestUser('onboarding')
  })

  test.afterEach(async () => {
    await cleanupUser(testUser.user.id)
  })

  test('shows username form', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/onboarding')
    await expect(page.getByLabel(/nazwa użytkownika/i)).toBeVisible()
  })

  test('redirects to /profil after setting username', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/onboarding')
    const username = `onb_${Date.now()}`.slice(0, 28).toLowerCase()
    await page.getByLabel(/nazwa użytkownika/i).fill(username)
    await page.getByRole('button', { name: /zapisz/i }).click()
    await page.waitForURL('/profil')
  })

  test('shows error for username shorter than 3 chars', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/onboarding')
    await page.getByLabel(/nazwa użytkownika/i).fill('ab')
    await page.getByRole('button', { name: /zapisz/i }).click()
    await expect(page.getByText(/co najmniej 3/i)).toBeVisible()
  })

  test('redirects to /profil if user already has username', async ({ page, context }) => {
    await supabaseAdmin.from('profiles').update({ username: 'already_set_user' }).eq('id', testUser.user.id)
    await testUser.injectSession(context)
    await page.goto('/onboarding')
    await page.waitForURL('/profil')
  })
})
