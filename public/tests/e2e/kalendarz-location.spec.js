import { test, expect } from '@playwright/test'

// Regression guard for the "Blisko mnie" geolocation filter.
//
// Permissions-Policy is set in public/vercel.json and mirrored onto the vite
// dev server by vite.config.js, so this test sees the same header production
// sends. If that header ever regresses to geolocation=() (empty allowlist —
// exactly what #1 shipped and #47 fixed), the browser denies the Geolocation
// API to the page itself even though this test grants the user permission,
// and the assertions below fail.

test.use({
  permissions: ['geolocation'],
  geolocation: { latitude: 52.2297, longitude: 21.0122 }, // Warszawa
})

test('Blisko mnie gets a position and activates the location filter', async ({ page }) => {
  await page.goto('/kalendarz')

  // Desktop and mobile render separate buttons; at the default desktop
  // viewport the first (desktop) one is the visible one.
  await page.getByRole('button', { name: 'Pokaż wydarzenia blisko mnie' }).first().click()

  // Success flips the button to the "clear location" state.
  await expect(page.getByRole('button', { name: 'Wyłącz filtr lokalizacji' }).first()).toBeVisible()
  await expect(page.getByText('Nie udało się pobrać lokalizacji')).toHaveCount(0)
})
