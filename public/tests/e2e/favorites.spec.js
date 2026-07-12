import { test, expect } from '@playwright/test'
import { createTestUser, cleanupUser, supabaseAdmin } from './helpers.js'
import { slugify } from '../../src/lib/slugify.js'

// Test calendar_events rows use source 'test' + unique source_id + far-future date.
// Always cleaned up in finally so we never leave junk in calendar_events.
async function createTestEvent(status = 'active', extra = {}) {
  const { data, error } = await supabaseAdmin
    .from('calendar_events')
    .insert({
      name: `E2E Fav Bieg ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      date: '2030-06-01',
      location: 'Testowo',
      source: 'test',
      source_id: `e2e-fav-${crypto.randomUUID()}`,
      status,
      ...extra,
    })
    .select('id, name, date')
    .single()
  if (error) throw error
  return data
}

async function deleteTestEvent(id) {
  await supabaseAdmin.from('calendar_events').delete().eq('id', id)
}

// Surface a single event in the kalendarz list via the search query param.
// The kalendarz time filter defaults to "Najbliższe" (today onward), and the
// test event's date is far-future, so it is within range. `?q=` seeds
// filters.search which drives the server-side name.ilike filter.
async function gotoKalendarzSearch(page, name) {
  await page.goto(`/kalendarz?q=${encodeURIComponent(name)}`)
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 15000 })
}

test.describe('Event favorites', () => {
  test('anon star click routes to login with from-param', async ({ page }) => {
    const event = await createTestEvent('active')
    try {
      await gotoKalendarzSearch(page, event.name)
      await page.getByTestId('star-event-btn').first().click()
      await expect(page).toHaveURL(/\/login\?from=/)
    } finally {
      await deleteTestEvent(event.id)
    }
  })

  test('logged-in star flow shows explainer modal and lists event on profil', async ({ page, context }) => {
    const event = await createTestEvent('active')
    const testUser = await createTestUser('fav-star')
    // Username required, otherwise /profil redirects to /onboarding.
    await supabaseAdmin
      .from('profiles')
      .update({ username: `fav_e2e_${Date.now()}`.toLowerCase().slice(0, 28) })
      .eq('id', testUser.user.id)
    try {
      await testUser.injectSession(context)
      // Wait for the favorites fetch to resolve — StarButton.handleClick is a
      // no-op while useFavorites().ready is false, so clicking too early does
      // nothing and the modal never opens.
      const favsResponse = page.waitForResponse(
        (r) => r.url().includes('/get-favorites'),
        { timeout: 15000 },
      )
      await gotoKalendarzSearch(page, event.name)
      await favsResponse

      const star = page.getByTestId('star-event-btn').first()
      await star.click()

      // First-ever star → explainer modal with the three notification triggers.
      const modal = page.getByTestId('first-star-modal')
      await expect(modal).toBeVisible()
      await expect(modal).toContainText('odwołany')
      await expect(modal).toContainText('link do zapisów')
      await expect(modal).toContainText('7 dni')

      await modal.getByRole('button', { name: 'Rozumiem' }).click()
      await expect(modal).toBeHidden()

      await expect(star).toHaveAttribute('aria-pressed', 'true')

      // Fresh page load resets the favorites module cache → /profil refetches
      // get-favorites, which now includes the just-starred event.
      await page.goto('/profil')
      const starredList = page.getByTestId('starred-list')
      await expect(starredList).toBeVisible({ timeout: 15000 })
      await expect(starredList).toContainText(event.name)
    } finally {
      await supabaseAdmin.from('event_favorites').delete().eq('user_id', testUser.user.id)
      await cleanupUser(testUser.user.id)
      await deleteTestEvent(event.id)
    }
  })

  test('cancelled event shows badge and hides registration CTA', async ({ page }) => {
    const event = await createTestEvent('cancelled')
    // Give it a registration_url so we can prove the CTA is hidden on cancel
    // (not merely absent because there was no URL).
    await supabaseAdmin
      .from('calendar_events')
      .update({ registration_url: 'https://example.com/zapisy' })
      .eq('id', event.id)
    try {
      await gotoKalendarzSearch(page, event.name)

      // Cancelled badge visible in the list row (desktop + mobile layouts both
      // render in the DOM, so scope to the first / use a count assertion).
      await expect(page.getByTestId('cancelled-badge').first()).toBeVisible()

      // Open the event page. The kalendarz row navigates to the slug-based event
      // page; go there directly via the same slugify the row uses — more robust
      // than a row click (which can be intercepted by the star/report controls).
      const slug = slugify(event.name, event.date)
      await page.goto(`/kalendarz/${slug}`)

      // Cancelled badge visible on the event page (single instance here).
      await expect(page.getByTestId('cancelled-badge')).toBeVisible({ timeout: 15000 })

      // Registration CTA ("Zapisy") must NOT render for cancelled events.
      await expect(page.getByRole('link', { name: 'Zapisy', exact: true })).toHaveCount(0)
    } finally {
      await deleteTestEvent(event.id)
    }
  })
})
