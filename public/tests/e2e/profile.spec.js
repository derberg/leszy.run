import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser } from './helpers.js'

async function loginAndOnboard(page, testUser, suffix) {
  await page.goto(testUser.magicLinkUrl)
  await page.waitForURL('/onboarding', { timeout: 15_000 })
  const handle = `prf_${suffix}_${Date.now()}`.toLowerCase().slice(0, 28)
  await page.getByLabel(/nazwa użytkownika/i).fill(handle)
  await page.getByRole('button', { name: /zapisz/i }).click()
  await page.waitForURL('/profil', { timeout: 15_000 })
  return handle
}

test.describe('/profil dashboard', () => {
  let testUser

  test.beforeEach(async () => {
    testUser = await createTestUser('profil')
  })

  test.afterEach(async () => {
    await cleanupUser(testUser.user.id)
  })

  test('unauthenticated visit redirects to /login', async ({ page }) => {
    await page.goto('/profil')
    await expect(page).toHaveURL('/login')
  })

  test('dashboard shows username after onboarding', async ({ page }) => {
    const handle = await loginAndOnboard(page, testUser, 'show')
    await expect(page.getByText(`@${handle}`)).toBeVisible()
  })

  test('user can edit display name', async ({ page }) => {
    await loginAndOnboard(page, testUser, 'edit')
    await page.getByTestId('edit-display_name').click({ force: true })
    await page.getByTestId('input-display_name').fill('Nowe Imię')
    await page.getByTestId('save-display_name').click()
    await expect(page.getByText('Nowe Imię')).toBeVisible({ timeout: 10_000 })
  })

  test('session persists after page reload', async ({ page }) => {
    await loginAndOnboard(page, testUser, 'session')
    await page.reload()
    await expect(page).toHaveURL('/profil')
    await expect(page.getByTestId('profil-page')).toBeVisible()
  })

  test('contribution history shows empty state initially', async ({ page }) => {
    await loginAndOnboard(page, testUser, 'empty')
    await expect(page.getByText(/brak wkładów/i)).toBeVisible()
  })
})
