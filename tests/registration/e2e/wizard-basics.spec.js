import crypto from 'node:crypto'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedFreeEvent } from '../helpers/registrationFixtures.js'

// Wizard feedback on Podstawy: W-76 (a taken address is reported on step 1 while typing, not
// only at publish) and W-72 / W-73 on the public event page (the description as plain text with
// its line breaks and bare links; the cause's page as a link beside the goal).
// Map tiles and Nominatim are answered locally.

const ZT = '00000000-0000-4000-8000-0000000000c1'

async function offline(page) {
  await page.route('https://nominatim.openstreetmap.org/**', (route) => route.fulfill({ json: [] }))
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
}

async function owner() {
  const session = await sessionFor(ACTOR_EMAILS.owner)
  const { body } = await callFn('organizer-status', session, { clubId: ZT })
  if (!body.data.agreementAccepted) await callFn('accept-organizer-agreement', session, { clubId: ZT, version: body.data.version })
  return session
}

test('W-76 a taken address shows „Ten adres jest już zajęty.” under the field on Podstawy while typing', async ({ actors }) => {
  const session = await owner()
  const other = await createPublishedFreeEvent(session)
  const { body } = await callFn('create-registration-event', session, { clubId: ZT, name: `Adres W76 ${crypto.randomUUID().slice(0, 6)}` })
  const page = await actors.owner.newPage()
  await offline(page)
  await page.goto(`/klub/zatyrani-test/wydarzenia/${body.data.eventId}/podstawy`)
  await expect(page.getByRole('heading', { name: 'Podstawy' })).toBeVisible()

  const slug = page.getByLabel('Adres strony')
  await slug.fill(other.slug)
  await expect(page.getByText('Ten adres jest już zajęty.').first()).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveURL(/\/podstawy$/)
  // The other fields keep saving while the address is refused.
  await page.getByLabel('Opis wydarzenia').fill('Opis zapisany mimo zajętego adresu')
  await expect.poll(async () => (await admin().from('registration_settings').select('description, slug')
    .eq('event_id', body.data.eventId).single()).data, { timeout: 15_000 })
    .toEqual({ description: 'Opis zapisany mimo zajętego adresu', slug: expect.not.stringMatching(new RegExp(`^${other.slug}$`)) })
  // A free address clears the message and is saved.
  const free = `wolny-adres-${crypto.randomUUID().slice(0, 8)}`
  await slug.fill(free)
  await expect(page.getByText('Ten adres jest już zajęty.')).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(async () => (await admin().from('registration_settings').select('slug')
    .eq('event_id', body.data.eventId).single()).data.slug, { timeout: 15_000 }).toBe(free)
})

test('W-72 W-73 the public event page shows the description as text with its links, and the cause page beside the goal', async ({ actors }) => {
  const session = await owner()
  const event = await createPublishedFreeEvent(session)
  const description = 'Nocny bieg po lesie.\nDruga linia.\n\nTrasa: https://example.org/trasa-w72. <b>pogrubienie</b>'
  await admin().from('registration_settings').update({
    description, is_charity: true, charity_goal: 'Rehabilitacja Zosi', charity_url: 'https://example.org/zosia',
  }).eq('event_id', event.eventId)

  const page = await actors.viewer.newPage()
  await offline(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/events/${event.slug}`)
  const box = page.getByTestId('event-description')
  await expect(box).toBeVisible()
  await expect(box).toContainText('O wydarzeniu')
  expect(await box.locator('p').innerText()).toBe('Nocny bieg po lesie.\nDruga linia.\n\nTrasa: https://example.org/trasa-w72. <b>pogrubienie</b>')
  await expect(box.locator('b')).toHaveCount(0)
  const link = box.getByRole('link', { name: 'https://example.org/trasa-w72' })
  await expect(link).toHaveAttribute('href', 'https://example.org/trasa-w72')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)

  await expect(page.getByTestId('charity-goal')).toContainText('Rehabilitacja Zosi')
  const cause = page.getByTestId('charity-link')
  await expect(cause).toHaveText('Strona celu ↗')
  await expect(cause).toHaveAttribute('href', 'https://example.org/zosia')
  await expect(cause).toHaveAttribute('target', '_blank')
  await expect(cause).toHaveAttribute('rel', /noopener/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('W-77 the public event page shows „Więcej informacji” with the event page under the description', async ({ actors }) => {
  const session = await owner()
  const event = await createPublishedFreeEvent(session)
  await admin().from('registration_settings').update({
    description: 'Nocny bieg po lesie.', website_url: 'https://example.org/wilczy-bieg-w77/',
  }).eq('event_id', event.eventId)

  const page = await actors.viewer.newPage()
  await offline(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/events/${event.slug}`)
  const more = page.getByTestId('event-website')
  await expect(more).toHaveText('Więcej informacji: example.org/wilczy-bieg-w77')
  const link = more.getByRole('link')
  await expect(link).toHaveAttribute('href', 'https://example.org/wilczy-bieg-w77/')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)
  await expect(page.getByTestId('event-description')).toContainText('Nocny bieg po lesie.')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
