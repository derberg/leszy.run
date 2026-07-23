import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import { createTestUser, cleanupUser, supabaseAdmin } from './helpers.js'

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

  // Regression: clicking the emailed magic link while localStorage holds a
  // fresh "anonymous" auth cache (written moments earlier, when the logged-out
  // user was on /login requesting the code). The login itself succeeds — the
  // session cookie is set — but if the cache isn't cleared before the hard
  // redirect, useAuth trusts the stale anon entry, skips /auth-me, and
  // AuthGuard bounces the freshly logged-in user straight back to /login.
  test('magic link logs in despite a fresh anonymous auth cache', async ({ page }) => {
    const testUser = await createTestUser('magic-link')
    const code = '654321'
    const codeHash = crypto.createHash('sha256').update(code).digest('hex')
    const { error } = await supabaseAdmin.from('auth_codes').insert({
      email: testUser.email,
      code_hash: codeHash,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    expect(error).toBeNull()

    // Seed the anon cache once (first page load only — the sentinel keeps the
    // post-login reload from re-seeding it, which real browsers never do).
    await page.addInitScript(() => {
      if (!localStorage.getItem('e2e.anon-seeded')) {
        localStorage.setItem('e2e.anon-seeded', '1')
        localStorage.setItem('leszy.auth.user', JSON.stringify({ user: null, ts: Date.now() }))
      }
    })

    await page.goto(`/login?email=${encodeURIComponent(testUser.email)}&code=${code}`)
    await page.waitForURL('/onboarding')
    // Must STAY authenticated on /onboarding — content only renders behind AuthGuard.
    await expect(page.getByLabel(/nazwa użytkownika/i)).toBeVisible()
    await expect(page).toHaveURL('/onboarding')

    await supabaseAdmin.from('auth_codes').delete().eq('email', testUser.email)
    await cleanupUser(testUser.user.id)
  })
})
