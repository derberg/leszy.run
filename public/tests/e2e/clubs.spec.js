import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser, cleanupClub, supabaseAdmin, FUNCTIONS_URL } from './helpers.js'

// Core happy-path coverage for the teams/clubs feature: create (via the
// /profil/klub ClubPicker "Utwórz klub" flow), owner state, join, and
// leave/delete. Create/join still happen on /profil/klub (unchanged
// ClubPicker testids); once a user has a club, `my-club-card` on
// /profil/klub links into the standalone slug-scoped area —
// /klub/:slug/panel (home + leave), /klub/:slug/czlonkowie (roster +
// join-request moderation), /klub/:slug/zaproszenia (invites),
// /klub/:slug/ustawienia (edit + danger zone). Hits the LIVE deployed
// backend and creates real `clubs` / `club_members` rows — every test
// cleans up its own club (cascades members/invites via cleanupClub) and
// its own users (cleanupUser), mirroring the conventions in
// favorites.spec.js / onboarding.spec.js / profile.spec.js.
// Club names are prefixed so they're recognizable as test data even if a run
// is interrupted before cleanup runs (global-setup's sweepTestData also
// sweeps `clubs` rows named `KB Testowo%` from the onboarding suite, but that
// pattern doesn't cover this file's clubs — cleanup here is not optional).

const CLUB_PREFIX = 'E2E Klub'

async function setUsername(sessionToken, username) {
  await fetch(`${FUNCTIONS_URL}/update-profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `leszy_session=${sessionToken}` },
    body: JSON.stringify({ username }),
  })
}

test.describe('Clubs', () => {
  test('create a club via ClubPicker "Utwórz klub" and see owner state', async ({ page, context }) => {
    const testUser = await createTestUser('clubs-create')
    const username = `clb_owner_${Date.now()}`.slice(0, 28).toLowerCase()
    const clubName = `${CLUB_PREFIX} Create ${Date.now()}`
    let clubId = null
    try {
      await setUsername(testUser.sessionToken, username)
      await testUser.injectSession(context)
      await page.goto('/profil/klub')

      await page.getByTestId('create-club-btn').click()
      await page.getByTestId('create-name').fill(clubName)
      await page.getByTestId('create-submit').click()

      // Creation stays on /profil/klub — the new club now shows as a
      // "my-clubs" card linking into the standalone /klub/:slug area.
      const card = page.getByTestId('my-club-card')
      await expect(card).toBeVisible({ timeout: 15000 })
      await expect(card).toContainText(clubName)
      await card.click()

      await page.waitForURL(/\/klub\/[^/]+\/panel/)
      await expect(page.getByTestId('klub-page')).toBeVisible({ timeout: 15000 })
      await expect(page.getByText(clubName)).toBeVisible()

      const { data: club } = await supabaseAdmin.from('clubs').select('id, owner_id').eq('name', clubName).single()
      clubId = club.id
      expect(club.owner_id).toBe(testUser.user.id)

      const { data: prof } = await supabaseAdmin.from('profiles').select('club_id').eq('id', testUser.user.id).single()
      expect(prof.club_id).toBe(clubId)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(testUser.user.id)
    }
  })

  test('member can request to join, get approved, then leave', async ({ page, context, browser }) => {
    const owner = await createTestUser('clubs-owner')
    const joiner = await createTestUser('clubs-joiner')
    const ownerUsername = `clb_own2_${Date.now()}`.slice(0, 28).toLowerCase()
    const joinerUsername = `clb_join_${Date.now()}`.slice(0, 28).toLowerCase()
    const clubName = `${CLUB_PREFIX} Join ${Date.now()}`
    let clubId = null
    try {
      await setUsername(owner.sessionToken, ownerUsername)
      await setUsername(joiner.sessionToken, joinerUsername)

      // Seed the club via the real create-club function as the owner session,
      // so ownership + profiles.club_id are set exactly like production.
      const createRes = await fetch(`${FUNCTIONS_URL}/create-club`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `leszy_session=${owner.sessionToken}` },
        body: JSON.stringify({ name: clubName }),
      })
      const created = await createRes.json()
      clubId = created.data.club.id
      const clubSlug = created.data.club.slug

      // Joiner searches for the club and requests to join, still on
      // /profil/klub (the no-club ClubPicker entry point).
      await joiner.injectSession(context)
      await page.goto('/profil/klub')
      await page.getByTestId('club-search-input').fill(clubName.slice(0, 20))
      await expect(page.getByTestId('club-option').first()).toBeVisible({ timeout: 5000 })
      await page.getByTestId('club-option').first().click()
      // The join-confirm box offers the roster-visibility choice before
      // sending the request — present on all four join entry points.
      await expect(page.getByTestId('visibility-choice')).toBeVisible()
      await page.getByTestId('confirm-join').click()
      await expect(page.getByTestId('club-pending-note')).toBeVisible()

      const { data: pendingRow } = await supabaseAdmin
        .from('club_members')
        .select('status')
        .eq('club_id', clubId)
        .eq('user_id', joiner.user.id)
        .single()
      expect(pendingRow.status).toBe('pending')

      // Owner approves the pending request from the roster page
      // (/klub/:slug/czlonkowie), in a separate browser context (both
      // sessions need to be live at once).
      const ownerContext = await browser.newContext()
      const ownerPage = await ownerContext.newPage()
      try {
        await owner.injectSession(ownerContext)
        await ownerPage.goto(`/klub/${clubSlug}/czlonkowie`)
        await ownerPage.getByTestId(`approve-${joiner.user.id}`).click()
        await expect(ownerPage.getByTestId(`approve-${joiner.user.id}`)).toBeHidden({ timeout: 10000 })
      } finally {
        await ownerContext.close()
      }

      // Joiner now shows up on the roster...
      await page.goto(`/klub/${clubSlug}/czlonkowie`)
      await expect(page.getByTestId('club-roster')).toBeVisible({ timeout: 15000 })

      // ...and leaves from the club panel (leave stays there, not the roster).
      await page.goto(`/klub/${clubSlug}/panel`)
      await page.getByTestId('leave-club-btn').click()
      await expect(page.getByTestId('leave-club-btn')).toBeHidden({ timeout: 10000 })

      const { data: afterLeave } = await supabaseAdmin
        .from('club_members')
        .select('status')
        .eq('club_id', clubId)
        .eq('user_id', joiner.user.id)
        .maybeSingle()
      expect(afterLeave).toBeNull()

      const { data: joinerProf } = await supabaseAdmin.from('profiles').select('club_id').eq('id', joiner.user.id).single()
      expect(joinerProf.club_id).toBeNull()
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
      await cleanupUser(joiner.user.id)
    }
  })

  test('owner can delete the club, returning to the no-club picker', async ({ page, context }) => {
    const testUser = await createTestUser('clubs-delete')
    const username = `clb_del_${Date.now()}`.slice(0, 28).toLowerCase()
    const clubName = `${CLUB_PREFIX} Delete ${Date.now()}`
    let clubId = null
    try {
      await setUsername(testUser.sessionToken, username)
      const createRes = await fetch(`${FUNCTIONS_URL}/create-club`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `leszy_session=${testUser.sessionToken}` },
        body: JSON.stringify({ name: clubName }),
      })
      const created = await createRes.json()
      clubId = created.data.club.id
      const clubSlug = created.data.club.slug

      await testUser.injectSession(context)
      // Delete/danger-zone controls now live on the settings page.
      await page.goto(`/klub/${clubSlug}/ustawienia`)
      await expect(page.getByTestId('delete-club-btn')).toBeVisible({ timeout: 15000 })

      await page.getByTestId('delete-club-btn').click()
      await page.getByTestId('confirm-delete-club').click()

      // Back to the no-club create/join picker.
      await expect(page.getByTestId('club-search-input')).toBeVisible({ timeout: 15000 })

      const { data: clubRow } = await supabaseAdmin.from('clubs').select('id').eq('id', clubId).maybeSingle()
      expect(clubRow).toBeNull()
      clubId = null // already gone — skip the redundant cleanupClub delete

      const { data: prof } = await supabaseAdmin.from('profiles').select('club_id').eq('id', testUser.user.id).single()
      expect(prof.club_id).toBeNull()
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(testUser.user.id)
    }
  })
})
