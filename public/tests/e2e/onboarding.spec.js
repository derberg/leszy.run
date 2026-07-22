import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser, cleanupClub, supabaseAdmin, FUNCTIONS_URL } from './helpers.js'

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
    await page.waitForURL(/\/profil/)
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
    await page.waitForURL(/\/profil/)
  })

  test('live check shows "zajęta" for a taken username', async ({ page, context }) => {
    const takenName = `taken_${Date.now()}`.slice(0, 28).toLowerCase()
    const other = await createTestUser('taken-owner')
    await supabaseAdmin.from('profiles').update({ username: takenName }).eq('id', other.user.id)
    try {
      await testUser.injectSession(context)
      await page.goto('/onboarding')
      await page.getByLabel(/nazwa użytkownika/i).fill(takenName)
      await expect(page.getByText(/zajęta/i)).toBeVisible({ timeout: 5000 })
    } finally {
      await cleanupUser(other.user.id)
    }
  })

  test('live check shows "dostępna" for a free username', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/onboarding')
    await page.getByLabel(/nazwa użytkownika/i).fill(`free_${Date.now()}`.slice(0, 28).toLowerCase())
    await expect(page.getByText(/dostępna/i)).toBeVisible({ timeout: 5000 })
  })

  // ClubPicker (see clubs.spec.js) replaced the old free-text ClubInput +
  // find_or_create_club pinning. During onboarding, picking an existing club
  // only files a join request (request-join) — it does NOT pin profiles.club_id
  // directly; that only happens once an owner/admin approves the request.
  test('club search during onboarding requests to join an existing club (does not pin it)', async ({ page, context }) => {
    const clubOwner = await createTestUser('onboarding-club-owner')
    const clubName = `KB Testowo ${Date.now()}`
    let clubId = null
    try {
      const createRes = await fetch(`${FUNCTIONS_URL}/create-club`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `leszy_session=${clubOwner.sessionToken}` },
        body: JSON.stringify({ name: clubName }),
      })
      const created = await createRes.json()
      clubId = created.data.club.id

      await testUser.injectSession(context)
      await page.goto('/onboarding')
      await page.getByTestId('club-search-input').fill('kb testowo')
      await expect(page.getByTestId('club-option').first()).toBeVisible({ timeout: 5000 })
      await page.getByTestId('club-option').first().click()
      await page.getByTestId('confirm-join').click()
      await expect(page.getByTestId('club-pending-note')).toBeVisible()

      const username = `clb_${Date.now()}`.slice(0, 28).toLowerCase()
      await page.getByLabel(/nazwa użytkownika/i).fill(username)
      await page.getByRole('button', { name: /zapisz/i }).click()
      await page.waitForURL(/\/profil/)

      const { data: membership } = await supabaseAdmin
        .from('club_members')
        .select('status')
        .eq('club_id', clubId)
        .eq('user_id', testUser.user.id)
        .single()
      expect(membership.status).toBe('pending')

      const { data: prof } = await supabaseAdmin.from('profiles').select('club_id').eq('id', testUser.user.id).single()
      expect(prof.club_id).toBeNull()
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(clubOwner.user.id)
    }
  })
})
