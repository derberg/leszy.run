import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import zlib from 'node:zlib'
import { test, expect } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedFreeEvent, createPublishedPaidEvent, makeClub } from '../helpers/registrationFixtures.js'
import { minutesFromNow, orderOk, paidOrderOk, person, runnerEmail, setSettings } from '../helpers/orders.js'

// Plan 7 task 9a: the organizer's side of tiered prices (A3), extras (A5b) and the locks after
// publish (A8). V-70: the owner builds the A3 tier fixture and an extra in a draft, and both
// survive a reload (autosave). V-71: after a registration the tier-1 cell is read-only, tier 2 is
// editable and „Opublikuj zmiany” applies it; a sold extra keeps its price and its sold variant.
// Task 9b: V-72 Płatności's codes, partners and package transfer (A6), V-73 B3's partner column,
// filter and dialog and the organizer's transfer, V-74 no button wraps at 390 px.
// Playwright loads the Deno-side modules as CommonJS, so nothing here imports
// supabase/functions/_shared.

const db = () => admin()
const hex = () => crypto.randomBytes(3).toString('hex')

/** A Warsaw calendar day `days` from today, as YYYY-MM-DD. */
function day(days) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date(Date.now() + days * 86_400_000))
}

/** A solid 480×320 PNG: an extra's image must be at least 400 px wide. */
function png(width = 480, height = 320) {
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
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x55)])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

async function contextFor(browser, email) {
  const context = await browser.newContext()
  const { token } = await sessionFor(email)
  await context.addCookies([{
    name: 'leszy_session', value: token, domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax',
  }])
  return context
}

/** A club of its own with the agreement accepted through the edge functions. → { club, owner } */
async function clubWithAgreement(prefix) {
  const slug = `${prefix}-${hex()}`
  const club = await makeClub({ slug, agreement: false })
  const owner = await sessionFor(club.ownerEmail)
  const status = await callFn('organizer-status', owner, { clubId: club.clubId })
  expect((await callFn('accept-organizer-agreement', owner, { clubId: club.clubId, version: status.body.data.version })).status).toBe(200)
  return { club, owner, slug }
}

async function tiersOf(eventId) {
  const { data, error } = await db().from('price_tiers').select('id, ends_on').eq('event_id', eventId)
    .order('ends_on', { ascending: true, nullsFirst: false })
  if (error) throw error
  return data
}

async function amountsOf(eventId, categoryId) {
  const tiers = await tiersOf(eventId)
  const { data, error } = await db().from('competition_prices').select('tier_id, amount').eq('category_id', categoryId)
  if (error) throw error
  return tiers.map((t) => data.find((p) => p.tier_id === t.id)?.amount ?? null)
}

async function extrasOf(eventId) {
  const { data, error } = await db().from('extras')
    .select('id, name, price, order_until, image_upload_id, extra_competitions(category_id), extra_variants(id, label, stock, sold, sort_order)')
    .eq('event_id', eventId).order('sort_order')
  if (error) throw error
  return data.map((x) => ({
    name: x.name, price: x.price, orderUntil: x.order_until, image: !!x.image_upload_id,
    categoryIds: x.extra_competitions.map((c) => c.category_id).sort(),
    variants: [...x.extra_variants].sort((a, b) => a.sort_order - b.sort_order).map((v) => [v.label, v.stock]),
  }))
}

test('V-70 the owner builds the A3 tiers and an extra in a draft; a reload keeps both (autosave)', async ({ browser }) => {
  test.setTimeout(150_000)
  const { club, owner, slug } = await clubWithAgreement('v70')
  const created = await callFn('create-registration-event', owner, { clubId: club.clubId, name: 'Charytatywny Bieg Leszego' })
  expect(created.status).toBe(201)
  const eventId = created.body.data.eventId
  const save = async (section, value) => {
    const r = await callFn('save-registration-section', owner, { eventId, section, value })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    return r.body.data
  }
  // The A3 fixture's dates, a year ahead so they never fall in the past.
  await save('basics', {
    eventDate: '2027-12-05', opensOn: '2027-11-01', closesOn: '2027-12-01', townLabel: 'Nieborowice', lat: 50.2381, lng: 18.5412,
    regulaminKind: 'link', regulaminUrl: 'https://example.org/regulamin.pdf', contactEmail: 'zapisy@klub.example',
  })
  const { categoryIds } = await save('competitions', { pricingMode: 'fixed', items: [
    { name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 120, price: '60' },
    { name: 'Bieg 3 km', kind: 'individual', discipline: 'run', distanceLabel: '3 km', startTime: '10:30', capacity: 80, price: '60' },
  ] })

  const ctx = await contextFor(browser, club.ownerEmail)
  const page = await ctx.newPage()
  const base = `/klub/${slug}/wydarzenia/${eventId}`
  await page.goto(`${base}/konkurencje`)

  // „Rośnie z datą zapisu” is offered (no „wkrótce”) and opens the grid: one dated tier and the close.
  const tiered = page.getByRole('radio', { name: 'Rośnie z datą zapisu' })
  await expect(tiered).toBeEnabled()
  await tiered.check()
  const grid = page.getByTestId('tiers')
  await expect(grid).toBeVisible()
  await expect(grid.getByRole('columnheader', { name: /DO KOŃCA ZAPISÓW/ })).toContainText('1.12')
  await page.getByLabel('Próg 1: do').fill('2027-11-15')
  await page.getByRole('button', { name: '+ Próg' }).click()
  await page.getByLabel('Próg 2: do').fill('2027-11-25')
  for (const name of ['Bieg 9 km', 'Bieg 3 km']) {
    for (const [n, zl] of [[1, '60'], [2, '70'], [3, '80']]) await page.getByLabel(`Cena ${name} · próg ${n}`).fill(zl)
  }
  await expect(grid.getByRole('columnheader', { name: /DO 15\.11/ })).toBeVisible()
  await expect(grid.getByRole('columnheader', { name: /DO 25\.11/ })).toBeVisible()

  await expect.poll(async () => (await tiersOf(eventId)).map((t) => t.ends_on), { timeout: 15_000 })
    .toEqual(['2027-11-15', '2027-11-25', null])
  for (const id of categoryIds) {
    await expect.poll(() => amountsOf(eventId, id), { timeout: 15_000 }).toEqual([6000, 7000, 8000])
  }
  const { data: rs } = await db().from('registration_settings').select('pricing_mode').eq('event_id', eventId).single()
  expect(rs.pricing_mode).toBe('tiered')

  // A date out of order is named under the grid, on the field, and nothing is saved.
  await page.getByLabel('Próg 2: do').fill('2027-11-10')
  const tierError = page.getByTestId('tiers-error')
  await expect(tierError).toBeVisible()
  await expect(page.getByLabel('Próg 2: do')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByLabel('Próg 2: do')).toHaveAttribute('aria-describedby', await tierError.getAttribute('id'))
  await page.getByLabel('Próg 2: do').fill('2027-11-25')
  await expect(tierError).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole('radio', { name: 'Rośnie z datą zapisu' })).toBeChecked()
  await expect(page.getByLabel('Próg 1: do')).toHaveValue('2027-11-15')
  await expect(page.getByLabel('Próg 2: do')).toHaveValue('2027-11-25')
  await expect(page.getByLabel('Cena Bieg 3 km · próg 3')).toHaveValue('80')

  // I-1: Stała saves one tier (today's, at its price, M-6) and deletes the rest; back to tiered,
  // the columns go out as new and save, with no stale tier id refused.
  await page.getByRole('radio', { name: 'Stała' }).check()
  await expect(page.getByLabel('Cena Bieg 9 km', { exact: true })).toHaveValue('60')
  await expect.poll(async () => (await tiersOf(eventId)).map((t) => t.ends_on), { timeout: 15_000 }).toEqual([null])
  await page.getByRole('radio', { name: 'Rośnie z datą zapisu' }).check()
  await expect(page.getByLabel('Próg 2: do')).toHaveValue('2027-11-25')
  await page.getByLabel('Cena Bieg 9 km · próg 3').fill('85')
  await expect.poll(async () => (await tiersOf(eventId)).map((t) => t.ends_on), { timeout: 15_000 })
    .toEqual(['2027-11-15', '2027-11-25', null])
  await expect.poll(() => amountsOf(eventId, categoryIds[0]), { timeout: 15_000 }).toEqual([6000, 7000, 8500])
  await expect(page.getByTestId('unsaved')).toHaveCount(0)
  // 9a M-4 (9b): a price the format accepts but the limit refuses still points its cell at the
  // message, not only a malformed one.
  const tooMuch = page.getByLabel('Cena Bieg 9 km · próg 3')
  await tooMuch.fill('1000000')
  await expect(page.getByTestId('tier-price-error')).toBeVisible()
  await expect(tooMuch).toHaveAttribute('aria-invalid', 'true')
  const describedBy = await tooMuch.getAttribute('aria-describedby')
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(await page.getByTestId('tier-price-error').innerText())
  await expect(page.getByLabel('Cena Bieg 9 km · próg 2')).not.toHaveAttribute('aria-invalid', 'true')
  await tooMuch.fill('85')
  await expect(page.getByTestId('tier-price-error')).toHaveCount(0)

  // A5b: an extra with an image, two variants (one without a limit) and one competition left out.
  await page.goto(`${base}/dodatki`)
  await expect(page.getByTestId('soon')).toHaveCount(0)
  await page.getByRole('button', { name: '+ Dodatek' }).click()
  const card = page.getByTestId('extra').first()
  await card.getByLabel('Nazwa').fill('Koszulka techniczna')
  // Typing the name flags none of the fields not reached yet; a field left empty is flagged.
  await expect(card.getByLabel('Cena')).not.toHaveAttribute('aria-invalid', 'true')
  await expect(card.getByLabel('Zamówienia do')).not.toHaveAttribute('aria-invalid', 'true')
  await expect(card.getByText('Podaj nazwę wariantu.')).toHaveCount(0)
  await card.getByLabel('Cena').focus()
  await card.getByLabel('Zamówienia do').focus()
  await expect(card.getByLabel('Cena')).toHaveAttribute('aria-invalid', 'true')
  await expect(card.getByLabel('Zamówienia do')).not.toHaveAttribute('aria-invalid', 'true')
  await card.getByLabel('Cena').fill('45')
  await card.getByLabel('Zamówienia do').fill('2027-11-20')
  await card.getByLabel('Wariant 1', { exact: true }).fill('M')
  await card.getByLabel('Limit sztuk 1').fill('40')
  await card.getByRole('button', { name: '+ wariant' }).click()
  await card.getByLabel('Wariant 2', { exact: true }).fill('L')
  const chip = card.getByRole('group', { name: 'Dostępne w konkurencjach' }).getByRole('button', { name: 'Bieg 3 km' })
  await expect(chip.getByText('✓')).toBeVisible()
  await chip.click()
  await expect(chip.getByText('✓')).toBeHidden()
  await card.getByTestId('extra-image-input').setInputFiles({ name: 'koszulka.png', mimeType: 'image/png', buffer: png() })
  await expect(card.getByRole('img', { name: 'Koszulka techniczna' })).toBeVisible({ timeout: 15_000 })

  await expect.poll(() => extrasOf(eventId), { timeout: 15_000 }).toEqual([{
    name: 'Koszulka techniczna', price: 4500, orderUntil: '2027-11-20', image: true,
    categoryIds: [categoryIds[0]], variants: [['M', 40], ['L', 100000]],
  }])

  await page.reload()
  const again = page.getByTestId('extra').first()
  await expect(again.getByLabel('Nazwa')).toHaveValue('Koszulka techniczna')
  await expect(again.getByLabel('Cena')).toHaveValue('45')
  await expect(again.getByLabel('Limit sztuk 1')).toHaveValue('40')
  await expect(again.getByLabel('Limit sztuk 2')).toHaveValue('')
  await expect(again.getByRole('button', { name: 'Bieg 3 km' })).toHaveAttribute('aria-pressed', 'false')
  await expect(again.getByRole('button', { name: 'Bieg 9 km' })).toHaveAttribute('aria-pressed', 'true')

  // A required field left empty is named on that field.
  await again.getByLabel('Nazwa').fill('')
  await expect(again.getByLabel('Nazwa')).toHaveAttribute('aria-invalid', 'true')
  await expect(again.getByText('Podaj nazwę dodatku.')).toBeVisible()
  await again.getByLabel('Nazwa').fill('Koszulka techniczna')

  // No button wraps and the page does not scroll sideways at 390 px.
  for (const path of ['konkurencje', 'dodatki']) {
    await page.goto(`${base}/${path}`)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId('event-editor')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const wrapped = await page.locator('button').evaluateAll((els) => els.filter((el) => el.offsetParent
      && getComputedStyle(el).whiteSpace !== 'nowrap' && el.getClientRects().length > 1).map((el) => el.textContent))
    expect(wrapped).toEqual([])
    await page.setViewportSize({ width: 1280, height: 800 })
  }
  await ctx.close()
})

test('V-71 after a registration: tier 1 is read-only, a tier-2 change is staged and applied; a sold extra keeps its price', async ({ browser }) => {
  test.setTimeout(150_000)
  const { club, owner, slug } = await clubWithAgreement('v71')
  const event = await createPublishedFreeEvent(owner, {
    clubSlug: slug, eventDate: day(40), opensOn: day(-1), closesOn: day(39),
    competitions: [{ name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }],
  })
  const categoryId = event.categoryIds[0]
  // Tiered after publish, LOCAL only (a shortcut: the wizard's tier grid on a draft is V-70). The club's
  // payout account is what a published event that takes money needs before „Opublikuj zmiany”.
  await db().from('club_payout_details').insert({
    club_id: club.clubId, legal_name: `Klub ${slug}`, nip: '5260250274', iban: 'PL61109010140000071219812874', address: 'ul. Leśna 1',
  }).throwOnError()
  const tiers = []
  for (const [i, endsOn] of [day(10), day(20), null].entries()) {
    const { data, error } = await db().from('price_tiers').insert({ event_id: event.eventId, ends_on: endsOn, sort_order: i }).select('*').single()
    if (error) throw error
    tiers.push(data)
  }
  await db().from('competition_prices').insert(tiers.map((t, i) => ({ category_id: categoryId, tier_id: t.id, amount: 6000 + i * 1000 }))).throwOnError()
  await db().from('registration_settings').update({ pricing_mode: 'tiered', payment_window_hours: 168 }).eq('event_id', event.eventId).throwOnError()
  const { data: extra } = await db().from('extras')
    .insert({ event_id: event.eventId, name: 'Koszulka', price: 4500, order_until: day(30) }).select('id').single().throwOnError()
  await db().from('extra_variants').insert([
    { extra_id: extra.id, label: 'M', stock: 10, sold: 1, sort_order: 1 },
    { extra_id: extra.id, label: 'L', stock: 10, sold: 0, sort_order: 2 },
  ]).throwOnError()
  // The registration: an order in tier 1 awaiting payment puts the competition in use.
  await orderOk({ ...event, prices: { [categoryId]: 6000 } })

  const ctx = await contextFor(browser, club.ownerEmail)
  const page = await ctx.newPage()
  const base = `/klub/${slug}/wydarzenia/${event.eventId}`
  await page.goto(`${base}/konkurencje`)
  const grid = page.getByTestId('tiers')
  await expect(grid).toBeVisible()
  await expect(page.getByLabel('Cena Bieg 9 km · próg 1')).toBeDisabled()
  await expect(page.getByLabel('Próg 1: do')).toBeDisabled()
  await expect(grid.getByRole('img', { name: /Są zgłoszenia/ }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Usuń próg 1' })).toHaveCount(0)
  await expect(page.getByLabel('Cena Bieg 9 km · próg 2')).toBeEnabled()
  await expect(page.getByLabel('Próg 2: do')).toBeEnabled()

  await page.getByLabel('Cena Bieg 9 km · próg 2').fill('75')
  const bar = page.getByTestId('pending-bar')
  await expect(bar).toContainText('Niezapisane zmiany: 1 · Bieg 9 km: opłaty', { timeout: 15_000 })
  await bar.getByRole('button', { name: 'Opublikuj zmiany' }).click()
  const dialog = page.getByRole('dialog', { name: 'Opublikować zmiany?' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('change-row')).toContainText('Bieg 9 km: opłaty')
  // A tiered event takes money. With PAID_REGISTRATION_ENABLED true and a payout account,
  // „Opublikuj zmiany” in the wizard applies the staged tier-2 change to the paid event.
  expect(await amountsOf(event.eventId, categoryId)).toEqual([6000, 7000, 8000])
  await dialog.getByRole('button', { name: 'Opublikuj', exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
  await expect.poll(() => amountsOf(event.eventId, categoryId), { timeout: 15_000 }).toEqual([6000, 7500, 8000])
  await page.reload()
  await expect(page.getByTestId('pending-bar')).toHaveCount(0)
  await expect(page.getByLabel('Cena Bieg 9 km · próg 2')).toHaveValue('75')
  await expect(page.getByLabel('Cena Bieg 9 km · próg 1')).toBeDisabled()

  // A8 on Dodatki: the sold extra's price and its sold variant are read-only; the rest is not.
  await page.goto(`${base}/dodatki`)
  const card = page.getByTestId('extra').first()
  await expect(card.getByLabel('Cena')).toBeDisabled()
  await expect(card.getByRole('button', { name: 'Usuń dodatek' })).toHaveCount(0)
  // M-2: the server lets a sold variant be renamed (ruling 10 locks price, existence and stock ≥ sold).
  await expect(card.getByLabel('Wariant 1', { exact: true })).toBeEnabled()
  await expect(card.getByRole('button', { name: 'Usuń wariant 1' })).toHaveCount(0)
  await expect(card.getByTestId('variant-sold').first()).toHaveText('SPRZEDANO 1')
  await expect(card.getByLabel('Wariant 2', { exact: true })).toBeEnabled()
  await expect(card.getByRole('button', { name: 'Usuń wariant 2' })).toBeVisible()
  await expect(card.getByLabel('Nazwa')).toBeEnabled()
  await ctx.close()
})

// ---------------------------------------------------------------- 9b: A6 and B3

const BIEG9 = { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }
const BIEG5 = { name: 'Bieg 5 km', discipline: 'run', distanceLabel: '5 km', startTime: '10:30', capacity: 50 }
const NW = { name: 'Nordic walking 9 km', discipline: 'nw', distanceLabel: '9 km', startTime: '10:05', capacity: 50 }

/** A published paid event of its own club, with Jan Kowalski and Anna Lis paid. */
async function paidEventWithEntries(prefix) {
  await resetThrottle()
  const { club, owner, slug } = await clubWithAgreement(prefix)
  const event = await createPublishedPaidEvent(owner, {
    clubSlug: slug, competitions: [BIEG9, BIEG5, NW], prices: { 'Bieg 9 km': 6000, 'Bieg 5 km': 6000, 'Nordic walking 9 km': 4000 },
  })
  const [c9] = event.categoryIds
  const one = (firstName, lastName) => ({ categoryId: c9, people: [person(runnerEmail(lastName.toLowerCase()), { firstName, lastName })] })
  const jan = await paidOrderOk(event, one('Jan', 'Kowalski'))
  await paidOrderOk(event, one('Anna', 'Lis'))
  return { club, owner, slug, event, jan, base: `/klub/${slug}/wydarzenia/${event.eventId}` }
}

/** Buttons whose label wrapped, or overflows its box, among the visible ones (a one-glyph ⓘ or × has no label to wrap). */
const wrappedButtons = (page) => page.locator('button:visible').evaluateAll((els) => els.filter((e) => e.textContent.trim().length > 1).filter((e) => {
  const s = getComputedStyle(e)
  const line = Number.parseFloat(s.lineHeight) || Number.parseFloat(s.fontSize) * 1.5
  const chrome = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((n, k) => n + Number.parseFloat(s[k]), 0)
  const single = Math.max(Number.parseFloat(s.minHeight) || 0, line + chrome)
  return e.getBoundingClientRect().height > single + 1 || e.scrollWidth > e.clientWidth + 1
}).map((e) => e.textContent))
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test('V-72 Płatności: a partner, 20 generated codes listed with it, the CSV with the BOM; the package transfer switch and date are kept', async ({ browser }) => {
  test.setTimeout(150_000)
  const { club, event, base } = await paidEventWithEntries('v72')
  const ctx = await contextFor(browser, club.ownerEmail)
  const page = await ctx.newPage()
  await page.goto(`${base}/platnosci`)

  // Partnerzy: „+ Partner”.
  const partners = page.getByTestId('partners')
  await partners.getByRole('button', { name: '+ Partner' }).click()
  const pd = page.getByRole('dialog', { name: 'Nowy partner' })
  await pd.getByLabel('Nazwa').fill('Sklep Biegacz')
  await pd.getByRole('button', { name: 'Dodaj partnera' }).click()
  await expect(pd).toHaveCount(0)
  await expect(partners.getByTestId('partner-row')).toHaveText([/Sklep Biegacz/])

  // Kody rabatowe: „Wygeneruj kody”, a 422 names its field first.
  const codes = page.getByTestId('vouchers')
  await codes.getByRole('button', { name: 'Wygeneruj kody' }).click()
  const gd = page.getByRole('dialog', { name: 'Wygeneruj kody' })
  await gd.getByLabel('Liczba kodów').fill('20')
  await gd.getByLabel('Rabat (%)').fill('150')
  await gd.getByLabel('Partner').selectOption({ label: 'Sklep Biegacz' })
  await gd.getByRole('button', { name: 'Wygeneruj', exact: true }).click()
  await expect(gd.getByLabel('Rabat (%)')).toHaveAttribute('aria-invalid', 'true')
  await expect(gd).toContainText('Rabat od 1 do 100%.')
  // 9b M-3: a 422 that names its field says so under it only, not again by the button.
  await expect(gd.getByTestId('dialog-error')).toHaveCount(0)
  await gd.getByLabel('Rabat (%)').fill('15')
  await gd.getByRole('button', { name: 'Wygeneruj', exact: true }).click()
  await expect(gd).toHaveCount(0)
  const rows = codes.getByTestId('voucher-row')
  await expect(rows).toHaveCount(20)
  await expect(codes.locator('thead th')).toHaveText(['Kod', 'Rabat', 'Użycia', 'Partner', 'Ważny do', 'Akcje'])
  await expect(rows.first()).toContainText('−15%')
  await expect(rows.first()).toContainText('0 / 1')
  await expect(rows.first()).toContainText('Sklep Biegacz')
  const { data: stored } = await db().from('vouchers').select('code, percent, max_uses, partner_id').eq('event_id', event.eventId)
  expect(stored).toHaveLength(20)
  expect(new Set(stored.map((v) => `${v.percent}/${v.max_uses}`))).toEqual(new Set(['15/1']))

  // One code of its own, then disabled; an unused one deleted.
  await codes.getByRole('button', { name: '+ Kod' }).click()
  const cd = page.getByRole('dialog', { name: 'Nowy kod' })
  await cd.getByLabel('Kod · opcjonalnie').fill('BIEGACZ10')
  await cd.getByLabel('Rabat (%)').fill('10')
  await cd.getByLabel('Limit użyć').fill('50')
  await cd.getByRole('button', { name: 'Dodaj kod' }).click()
  await expect(cd).toHaveCount(0)
  await expect(rows).toHaveCount(21)
  const own = rows.filter({ hasText: 'BIEGACZ10' })
  await own.getByRole('button', { name: 'Wyłącz — BIEGACZ10' }).click()
  await expect(own).toContainText('WYŁĄCZONY')
  // 9b M-2: „Usuń” asks first; „Nie” keeps the code, „Usuń” in the question deletes it.
  await own.getByRole('button', { name: 'Usuń — BIEGACZ10' }).click()
  const ask = page.getByRole('alertdialog', { name: 'Usunąć kod BIEGACZ10?' })
  await ask.getByRole('button', { name: 'Nie' }).click()
  await expect(ask).toHaveCount(0)
  await expect(rows).toHaveCount(21)
  await own.getByRole('button', { name: 'Usuń — BIEGACZ10' }).click()
  await ask.getByRole('button', { name: 'Usuń' }).click()
  await expect(rows).toHaveCount(20)
  // A partner nobody carries is deleted the same way.
  await partners.getByRole('button', { name: '+ Partner' }).click()
  await page.getByRole('dialog', { name: 'Nowy partner' }).getByLabel('Nazwa').fill('Radio Piekary')
  await page.getByRole('dialog', { name: 'Nowy partner' }).getByRole('button', { name: 'Dodaj partnera' }).click()
  await expect(partners.getByTestId('partner-row')).toHaveCount(2)
  await partners.getByRole('button', { name: 'Usuń — Radio Piekary' }).click()
  await page.getByRole('alertdialog', { name: 'Usunąć partnera Radio Piekary?' }).getByRole('button', { name: 'Usuń' }).click()
  await expect(partners.getByTestId('partner-row')).toHaveText([/Sklep Biegacz/])

  // „Eksport CSV”: the server's file, BOM first.
  const [download] = await Promise.all([page.waitForEvent('download'), codes.getByRole('button', { name: 'Eksport CSV' }).click()])
  expect(download.suggestedFilename()).toMatch(/^kody-.+-\d{4}-\d\d-\d\d\.csv$/)
  const bytes = await fs.readFile(await download.path())
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  const lines = bytes.toString('utf8').slice(1).split('\r\n')
  expect(lines[0]).toBe('"Kod";"Rabat";"Wykorzystano";"Limit";"Ważny do";"Partner";"Notatka"')
  expect(lines).toHaveLength(21)

  // Przekazanie pakietu: allowed until a date; after publish it is staged, and a reload shows it.
  const transfer = page.getByTestId('transfer-settings')
  await expect(transfer.getByLabel('Możliwe do')).toHaveCount(0)
  await transfer.getByRole('radio', { name: 'Pozwalam przekazać pakiet' }).click()
  const until = transfer.getByLabel('Możliwe do')
  await expect(until).toHaveAttribute('max', new Date(Date.parse(`${event.eventDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10))
  await until.fill(day(10))
  await expect.poll(async () => {
    const { data } = await db().from('registration_pending_changes').select('payload').eq('event_id', event.eventId).maybeSingle()
    return data?.payload?.payments ?? null
  }, { timeout: 15_000 }).toMatchObject({ transfer_enabled: true, transfer_until: day(10) })
  // The section goes out whole (window + transfer), but only what differs from live is a change:
  // the unchanged window is not listed for „Opublikuj zmiany” (review open item).
  const { data: staged } = await db().from('registration_pending_changes').select('changed_fields').eq('event_id', event.eventId).single()
  expect([...staged.changed_fields].sort()).toEqual(['payments.transfer_enabled', 'payments.transfer_until'])
  await page.reload()
  await expect(page.getByTestId('transfer-settings').getByRole('radio', { name: 'Pozwalam przekazać pakiet' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('transfer-settings').getByLabel('Możliwe do')).toHaveValue(day(10))
  await ctx.close()
})

test('V-73 B3: ⋯ „Partner” sets it and the „Partnerzy” filter shows that row; an organizer transfer after close leaves „WYCOFAJ W PANELU POMIARU”', async ({ browser }) => {
  test.setTimeout(150_000)
  const { club, owner, event, jan, base } = await paidEventWithEntries('v73')
  const partners = (body) => callFn('organizer-partners', owner, { eventId: event.eventId, ...body })
  expect((await partners({ action: 'create', name: 'Sklep Biegacz', isPublic: false })).status).toBe(201)
  expect((await partners({ action: 'create', name: 'Radio Piekary', isPublic: false })).status).toBe(201)
  const ctx = await contextFor(browser, club.ownerEmail)
  const page = await ctx.newPage()
  await page.goto(`${base}/zgloszenia`)
  const table = page.getByTestId('registrations')
  const row = (name) => table.getByTestId('registration-row').filter({ has: page.getByText(name, { exact: true }) })
  await expect(table.locator('thead th')).toHaveText(['Nr', 'Zawodnik / drużyna', 'Konkurencja', 'Status', 'Wpłata', 'Partner', 'Akcje'])
  await expect(row('Jan Kowalski').getByTestId('registration-partner')).toHaveText('—')

  const trigger = page.getByRole('button', { name: 'Akcje — Jan Kowalski' }).first()
  await trigger.click()
  expect(await page.getByRole('menu').getByRole('menuitem').allTextContents())
    .toEqual(['Edytuj dane', 'Napisz do zawodnika', 'Partner', 'Przekaż pakiet', 'Zwróć wpłatę', 'Anuluj zgłoszenie'])
  await page.getByRole('menuitem', { name: 'Partner', exact: true }).click()
  const pd = page.getByRole('dialog', { name: 'Partner' })
  await expect(pd.getByRole('radio', { name: 'Bez partnera' })).toBeChecked()
  await pd.getByRole('radio', { name: 'Sklep Biegacz' }).check()
  await pd.getByRole('button', { name: 'Zapisz' }).click()
  await expect(pd).toHaveCount(0)
  await expect(page.getByTestId('entries-notice')).toHaveText('Partner: Sklep Biegacz — Jan Kowalski.')
  await expect(trigger).toBeFocused()
  await expect(row('Jan Kowalski').getByTestId('registration-partner')).toHaveText('Sklep Biegacz')
  const { data: [janReg] } = await db().from('registrations').select('partner_id').eq('order_id', jan.orderId)
  const { data: [sklep] } = await db().from('event_partners').select('id').eq('event_id', event.eventId).eq('name', 'Sklep Biegacz')
  expect(janReg.partner_id).toBe(sklep.id)

  const chips = page.getByTestId('partner-chips')
  await expect(chips.getByRole('button')).toHaveText(['Wszyscy', 'Radio Piekary · 0', 'Sklep Biegacz · 1'])
  await chips.getByRole('button', { name: 'Sklep Biegacz · 1' }).click()
  await expect(table.getByTestId('registration-row')).toHaveText([/Jan Kowalski/])
  await chips.getByRole('button', { name: 'Wszyscy' }).click()
  await expect(table.getByTestId('registration-row')).toHaveCount(2)

  // After closes_at: the organizer transfers, the host owns the old participant.
  await setSettings(event.eventId, { closes_at: minutesFromNow(-1) })
  await page.reload()
  await page.getByRole('button', { name: 'Akcje — Jan Kowalski' }).first().click()
  await page.getByRole('menuitem', { name: 'Przekaż pakiet', exact: true }).click()
  const td = page.getByRole('dialog', { name: 'Przekaż pakiet' })
  // Same price only: Bieg 9 km and Bieg 5 km (60 zł), never NW (40 zł).
  await expect(td.getByLabel('Konkurencja').locator('option')).toHaveText(['Bieg 9 km', 'Bieg 5 km'])
  await expect(td.getByLabel('Konkurencja')).toHaveValue(event.categoryIds[0])
  await td.getByLabel('Imię', { exact: true }).fill('Adam')
  await td.getByLabel('Nazwisko').fill('Nowy')
  await td.getByLabel('Data urodzenia').fill('2015-05-05')
  await td.getByRole('button', { name: 'Mężczyzna' }).click()
  await td.getByLabel('E-mail').fill(runnerEmail('nowy'))
  await td.getByLabel('Telefon', { exact: true }).fill('600700800')
  await td.getByRole('button', { name: 'Przekaż pakiet' }).click()
  // A refusal reads near the button, and the field it is about is marked.
  await expect(td.getByTestId('dialog-error')).toHaveText('Pakiet może przejąć tylko osoba pełnoletnia.')
  await expect(td.getByLabel('Data urodzenia')).toHaveAttribute('aria-invalid', 'true')
  await td.getByLabel('Data urodzenia').fill('1985-05-05')
  await td.getByRole('button', { name: 'Przekaż pakiet' }).click()
  await expect(td).toHaveCount(0)
  await expect(page.getByTestId('entries-notice')).toHaveText('Pakiet przekazany: Jan Kowalski → Adam Nowy.')
  await expect(row('Jan Kowalski').getByTestId('registration-status')).toHaveText('WYCOFAJ W PANELU POMIARU')
  await expect(row('Adam Nowy').getByTestId('registration-status')).toHaveText('OPŁACONE')
  // The partner moved with the package; the chip counts the one live package, not both rows (9b I-1).
  await expect(row('Adam Nowy').getByTestId('registration-partner')).toHaveText('Sklep Biegacz')
  await expect(chips.getByRole('button', { name: /^Sklep Biegacz/ })).toHaveText('Sklep Biegacz · 1')
  await ctx.close()
})

test('V-74 no button wraps at 390 px: Płatności with codes and partners, the panel with partners, PartnerDialog and TransferDialog', async ({ browser }) => {
  test.setTimeout(120_000)
  const { club, owner, event, base } = await paidEventWithEntries('v74')
  const vouchers = (body) => callFn('organizer-vouchers', owner, { eventId: event.eventId, ...body })
  const partner = await callFn('organizer-partners', owner, { eventId: event.eventId, action: 'create', name: 'Stowarzyszenie Biegaczy Ziemi Gliwickiej', isPublic: false })
  expect(partner.status).toBe(201)
  expect((await vouchers({ action: 'generate', n: 3, percent: 10, partnerId: partner.body.data.id, validUntil: day(20) })).status).toBe(201)
  const ctx = await contextFor(browser, club.ownerEmail)
  const page = await ctx.newPage()
  await page.setViewportSize({ width: 390, height: 844 })

  await page.goto(`${base}/platnosci`)
  // 9b M-1: cards at 390 px, every action in view, nothing clipped in a scroll box.
  const cards390 = page.getByTestId('vouchers').getByTestId('voucher-card')
  await expect(cards390).toHaveCount(3)
  for (const name of ['Wyłącz', 'Usuń']) {
    const box = await cards390.first().getByRole('button', { name: new RegExp(`^${name} —`) }).boundingBox()
    expect(box.x + box.width).toBeLessThanOrEqual(390)
  }
  await expect(cards390.first()).toContainText('Stowarzyszenie Biegaczy Ziemi Gliwickiej')
  await cards390.first().getByRole('button', { name: /^Usuń —/ }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  expect(await wrappedButtons(page)).toEqual([])
  expect(await noSideways(page)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await page.getByTestId('transfer-settings').getByRole('radio', { name: 'Pozwalam przekazać pakiet' }).click()
  await expect(page.getByTestId('transfer-settings').getByLabel('Możliwe do')).toBeVisible()
  expect(await wrappedButtons(page)).toEqual([])
  expect(await noSideways(page)).toBe(true)
  for (const name of ['Wygeneruj kody', '+ Kod']) {
    await page.getByTestId('vouchers').getByRole('button', { name }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    expect(await wrappedButtons(page)).toEqual([])
    expect(await noSideways(page)).toBe(true)
    await page.keyboard.press('Escape')
  }

  await page.goto(`${base}/zgloszenia`)
  const cards = page.getByTestId('registrations-cards')
  await expect(cards.getByTestId('registration-card')).toHaveCount(2)
  await expect(page.getByTestId('partner-chips')).toBeVisible()
  expect(await wrappedButtons(page)).toEqual([])
  expect(await noSideways(page)).toBe(true)
  for (const item of ['Partner', 'Przekaż pakiet']) {
    await cards.getByRole('button', { name: 'Akcje — Jan Kowalski' }).click()
    await page.getByRole('menuitem', { name: item, exact: true }).click()
    await expect(page.getByRole('dialog', { name: item })).toBeVisible()
    expect(await wrappedButtons(page)).toEqual([])
    expect(await noSideways(page)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
  await ctx.close()
})
