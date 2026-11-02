import zlib from 'node:zlib'
import { test, expect } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'

// The wizard step „Partnerzy” (event partners, task 6). EP-18: the owner adds a partner with a
// link, a note and a logo, another one hidden, reorders them; the code dialog in Płatności lists
// both, the hidden one „(ukryty)”; deleting the partner a code holds reads the 409; the public page
// shows the public one only. EP-19: no partners → the code dialog links to the step; a 422 and a
// client-side logo refusal read under their fields. EP-20: a club member sees the public partners
// read-only; at 390 px nothing scrolls sideways and no button wraps, the dialog included.
// Playwright loads the Deno-side modules as CommonJS, so nothing here imports supabase/functions/_shared.

const db = () => admin()
const step = (eventId, key) => `/klub/zatyrani-test/wydarzenia/${eventId}/${key}`

/** A solid PNG, `width`×`height`. */
function png(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x66)])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0)),
  ])
}

async function partnersOf(eventId) {
  const { data, error } = await db().from('event_partners')
    .select('id, name, note, website_url, logo_url, logo_path, is_public, sort_order').eq('event_id', eventId).order('sort_order')
  if (error) throw error
  return data
}

async function open(context, path) {
  const page = await context.newPage()
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  await page.goto(path)
  return page
}

/** Buttons whose label wrapped, or overflows its box, among the visible ones (a one-glyph ↑ ↓ has no label to wrap). */
const wrappedButtons = (page) => page.locator('button:visible').evaluateAll((els) => els.filter((e) => e.textContent.trim().length > 1).filter((e) => {
  const s = getComputedStyle(e)
  const line = Number.parseFloat(s.lineHeight) || Number.parseFloat(s.fontSize) * 1.5
  const chrome = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((n, k) => n + Number.parseFloat(s[k]), 0)
  const single = Math.max(Number.parseFloat(s.minHeight) || 0, line + chrome)
  return e.getBoundingClientRect().height > single + 1 || e.scrollWidth > e.clientWidth + 1
}).map((e) => e.textContent))
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

let owner
test.beforeEach(async () => {
  await resetThrottle()
  owner = await sessionFor('owner@zatyrani-test.local')
})

test('EP-18 Partnerzy: a partner with link, note and logo, a hidden one, reordered; the code dialog lists both („(ukryty)”); a partner a code holds is not deleted; the public page shows the public one', async ({ actors }) => {
  test.setTimeout(120_000)
  const e = await createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000 } })
  const page = await open(actors.owner, step(e.eventId, 'partnerzy'))
  // A published event shows the step as a tab, after Dodatki and before Płatności.
  const tabs = page.getByRole('tablist', { name: 'Zakładki' }).getByRole('tab')
  await expect(tabs.filter({ hasText: 'Partnerzy' })).toHaveCount(1)
  const names = (await tabs.allTextContents()).map((t) => t.trim())
  expect(names.indexOf('Partnerzy')).toBe(names.indexOf('Dodatki') + 1)
  expect(names.indexOf('Płatności')).toBe(names.indexOf('Partnerzy') + 1)
  const card = page.getByTestId('partners')
  await expect(card.getByTestId('partners-empty')).toHaveText('Brak partnerów.')

  // „+ Partner”: name, link, note, a logo, shown on the event page (the default).
  await card.getByRole('button', { name: '+ Partner' }).click()
  const pd = page.getByRole('dialog', { name: 'Nowy partner' })
  await expect(pd.getByLabel('Pokazuj na stronie wydarzenia')).toBeChecked()
  await expect(pd).toContainText('PNG, JPG lub WebP')
  await pd.getByLabel('Nazwa').fill('Sklep Biegacz')
  await pd.getByLabel('Link do strony (opcjonalnie)').fill('https://www.sklep-biegacz.pl/promo')
  await pd.getByLabel('Notatka (widoczna tylko dla organizatorów)').fill('Umowa do grudnia')
  await pd.getByTestId('logo-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png(1200, 300) })
  await expect(pd.getByRole('button', { name: 'Usuń logo' })).toBeVisible()
  await pd.getByRole('button', { name: 'Dodaj partnera' }).click()
  // upload-partner-logo decodes and re-encodes the image: a cold function takes a while.
  await expect(pd).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('partners-notice')).toHaveText('Dodano partnera Sklep Biegacz.')
  const rows = card.getByTestId('partner-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('sklep-biegacz.pl')
  await expect(rows.first()).toContainText('Umowa do grudnia')
  await expect(rows.first().locator('img')).toHaveCount(1)
  let stored = await partnersOf(e.eventId)
  expect(stored).toHaveLength(1)
  expect([stored[0].name, stored[0].note, stored[0].website_url, stored[0].is_public])
    .toEqual(['Sklep Biegacz', 'Umowa do grudnia', 'https://www.sklep-biegacz.pl/promo', true])
  // The browser drew it inside 800×800 and sent a PNG; the server keeps a PNG at the bucket root.
  expect(stored[0].logo_path).toMatch(/^[0-9a-f-]{36}\.png$/)

  // A second one, then „Zmień” to hide it: „UKRYTY” on its row.
  await card.getByRole('button', { name: '+ Partner' }).click()
  await page.getByRole('dialog', { name: 'Nowy partner' }).getByLabel('Nazwa').fill('Radio Piekary')
  await page.getByRole('dialog', { name: 'Nowy partner' }).getByRole('button', { name: 'Dodaj partnera' }).click()
  await expect(rows).toHaveCount(2)
  await card.getByRole('button', { name: 'Zmień — Radio Piekary' }).click()
  const ed = page.getByRole('dialog', { name: 'Partner' })
  await expect(ed.getByLabel('Nazwa')).toHaveValue('Radio Piekary')
  await ed.getByLabel('Pokazuj na stronie wydarzenia').uncheck()
  await ed.getByRole('button', { name: 'Zapisz' }).click()
  await expect(ed).toHaveCount(0)
  await expect(page.getByTestId('partners-notice')).toHaveText('Zapisano — Radio Piekary.')
  await expect(rows.nth(1).getByTestId('partner-hidden')).toHaveText('UKRYTY')
  await expect(rows.first().getByTestId('partner-hidden')).toHaveCount(0)

  // ↑ moves Radio Piekary first; ↑ on the first row and ↓ on the last are off.
  await card.getByRole('button', { name: 'Wyżej — Radio Piekary' }).click()
  await expect(rows).toHaveText([/Radio Piekary/, /Sklep Biegacz/])
  await expect(card.getByRole('button', { name: 'Wyżej — Radio Piekary' })).toBeDisabled()
  await expect(card.getByRole('button', { name: 'Niżej — Sklep Biegacz' })).toBeDisabled()
  stored = await partnersOf(e.eventId)
  expect(stored.map((p) => [p.name, p.is_public])).toEqual([['Radio Piekary', false], ['Sklep Biegacz', true]])

  // Płatności: no partner card; the code dialog lists both, the hidden one marked.
  await page.getByRole('tab', { name: 'Płatności' }).click()
  const codes = page.getByTestId('vouchers')
  await expect(codes).toBeVisible()
  await expect(page.getByTestId('partners')).toHaveCount(0)
  await codes.getByRole('button', { name: '+ Kod' }).click()
  const cd = page.getByRole('dialog', { name: 'Nowy kod' })
  await expect(cd.getByLabel('Partner').locator('option')).toHaveText(['—', 'Radio Piekary (ukryty)', 'Sklep Biegacz'])
  await cd.getByLabel('Kod · opcjonalnie').fill('RADIO10')
  await cd.getByLabel('Rabat (%)').fill('10')
  await cd.getByLabel('Partner').selectOption({ label: 'Radio Piekary (ukryty)' })
  await cd.getByRole('button', { name: 'Dodaj kod' }).click()
  await expect(cd).toHaveCount(0)
  await expect(codes.getByTestId('voucher-row').filter({ hasText: 'RADIO10' })).toContainText('Radio Piekary')

  // Back in Partnerzy: deleting the partner the code holds asks, then reads the 409; the row stays.
  await page.getByRole('tab', { name: 'Partnerzy' }).click()
  await card.getByRole('button', { name: 'Usuń — Radio Piekary' }).click()
  await page.getByRole('alertdialog', { name: 'Usunąć partnera Radio Piekary?' }).getByRole('button', { name: 'Usuń' }).click()
  await expect(page.getByTestId('partners-notice')).toHaveText('Partnera przypisanego do kodów lub zgłoszeń nie można usunąć.')
  await expect(rows).toHaveCount(2)

  // The public page: the public partner only, linked, on the page's own theme.
  const pub = await open(actors.viewer, `/events/${e.slug}`)
  const logos = pub.getByTestId('partner-logos')
  await expect(logos).toBeVisible()
  await expect(logos.getByRole('link')).toHaveCount(1)
  await expect(logos.getByRole('link')).toHaveAttribute('href', 'https://www.sklep-biegacz.pl/promo')
  await expect(logos.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer sponsored')
  await expect(logos.getByRole('img', { name: 'Sklep Biegacz' })).toHaveCount(1)
  await expect(logos).not.toContainText('Radio Piekary')
  await expect(pub.locator('body')).not.toContainText('Umowa do grudnia')
})

test('EP-19 no partners: the code dialog links to the step; a bad link and an SVG logo read under their fields', async ({ actors }) => {
  test.setTimeout(90_000)
  const e = await createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000 } })
  const page = await open(actors.owner, step(e.eventId, 'platnosci'))
  await page.getByTestId('vouchers').getByRole('button', { name: '+ Kod' }).click()
  const cd = page.getByRole('dialog', { name: 'Nowy kod' })
  await expect(cd.getByLabel('Partner')).toHaveCount(0)
  await cd.getByRole('link', { name: 'Dodaj partnerów' }).click()
  await expect(page).toHaveURL(new RegExp(`${e.eventId}/partnerzy$`))
  await expect(page.getByTestId('partners-empty')).toBeVisible()

  await page.getByTestId('partners').getByRole('button', { name: '+ Partner' }).click()
  const pd = page.getByRole('dialog', { name: 'Nowy partner' })
  // An SVG never leaves the browser.
  await pd.getByTestId('logo-input').setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') })
  await expect(pd).toContainText('Dozwolone: PNG, JPG, WebP.')
  await expect(pd.getByRole('button', { name: 'Usuń logo' })).toHaveCount(0)
  // The server's 422 under the link, not by the buttons.
  await pd.getByLabel('Nazwa').fill('Sklep Biegacz')
  await pd.getByLabel('Link do strony (opcjonalnie)').fill('sklep-biegacz.pl')
  await pd.getByRole('button', { name: 'Dodaj partnera' }).click()
  const link = pd.getByLabel('Link do strony (opcjonalnie)')
  await expect(link).toHaveAttribute('aria-invalid', 'true')
  await expect(pd).toContainText('Podaj adres zaczynający się od http:// lub https://.')
  await expect(pd.getByTestId('dialog-error')).toHaveCount(0)
  expect(await partnersOf(e.eventId)).toEqual([])
  await link.fill('https://sklep-biegacz.pl')
  await pd.getByRole('button', { name: 'Dodaj partnera' }).click()
  await expect(pd).toHaveCount(0)
  expect((await partnersOf(e.eventId)).map((p) => p.website_url)).toEqual(['https://sklep-biegacz.pl'])
})

test('EP-20 a club member sees the public partners read-only; at 390 px nothing scrolls sideways and no button wraps', async ({ actors }) => {
  test.setTimeout(90_000)
  const e = await createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000 } })
  const call = (body) => callFn('organizer-partners', owner, { eventId: e.eventId, ...body })
  expect((await call({ action: 'create', name: 'Stowarzyszenie Biegaczy Ziemi Gliwickiej i Okolic', websiteUrl: 'https://www.stowarzyszenie-biegaczy-ziemi-gliwickiej.example.org/partnerzy', note: 'Długa notatka '.repeat(12) })).status).toBe(201)
  expect((await call({ action: 'create', name: 'Hurtownia', isPublic: false, note: 'tylko kody' })).status).toBe(201)

  // The member: the public partner, no note, no buttons.
  const m = await open(actors.member, step(e.eventId, 'partnerzy'))
  const mRows = m.getByTestId('partner-row')
  await expect(mRows).toHaveCount(1)
  await expect(mRows.first()).toContainText('Stowarzyszenie Biegaczy Ziemi Gliwickiej i Okolic')
  await expect(m.getByTestId('partners')).not.toContainText('Hurtownia')
  await expect(m.getByTestId('partners').getByRole('button')).toHaveCount(0)

  // The owner at 390 px.
  const page = await open(actors.owner, step(e.eventId, 'partnerzy'))
  await page.setViewportSize({ width: 390, height: 844 })
  const rows = page.getByTestId('partner-row')
  await expect(rows).toHaveCount(2)
  for (const name of ['Zmień', 'Usuń']) {
    const box = await rows.first().getByRole('button', { name: new RegExp(`^${name} —`) }).boundingBox()
    expect(box.x + box.width).toBeLessThanOrEqual(390)
  }
  expect(await wrappedButtons(page)).toEqual([])
  expect(await noSideways(page)).toBe(true)
  await page.getByTestId('partners').getByRole('button', { name: '+ Partner' }).click()
  await expect(page.getByRole('dialog', { name: 'Nowy partner' })).toBeVisible()
  expect(await wrappedButtons(page)).toEqual([])
  expect(await noSideways(page)).toBe(true)
  await page.keyboard.press('Escape')
  await rows.first().getByRole('button', { name: /^Zmień —/ }).click()
  await expect(page.getByRole('dialog', { name: 'Partner' })).toBeVisible()
  expect(await wrappedButtons(page)).toEqual([])
  expect(await noSideways(page)).toBe(true)
  await page.keyboard.press('Escape')
  await rows.first().getByRole('button', { name: /^Usuń —/ }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  expect(await wrappedButtons(page)).toEqual([])
  expect(await noSideways(page)).toBe(true)
})
