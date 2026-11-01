import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { test, expect } from './fixtures.js'
import { admin, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedFreeEvent, makeClub } from '../helpers/registrationFixtures.js'
import { orderOk } from '../helpers/orders.js'

// Plan 7 task 9a: the organizer's side of tiered prices (A3), extras (A5b) and the locks after
// publish (A8). V-70: the owner builds the A3 tier fixture and an extra in a draft, and both
// survive a reload (autosave). V-71: after a registration the tier-1 cell is read-only, tier 2 is
// editable and „Opublikuj zmiany” applies it; a sold extra keeps its price and its sold variant.
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

  // A5b: an extra with an image, two variants (one without a limit) and one competition left out.
  await page.goto(`${base}/dodatki`)
  await expect(page.getByTestId('soon')).toHaveCount(0)
  await page.getByRole('button', { name: '+ Dodatek' }).click()
  const card = page.getByTestId('extra').first()
  await card.getByLabel('Nazwa').fill('Koszulka techniczna')
  await card.getByLabel('Cena').fill('45')
  await card.getByLabel('Zamówienia do').fill('2027-11-20')
  await card.getByLabel('Wariant 1', { exact: true }).fill('M')
  await card.getByLabel('Limit sztuk 1').fill('40')
  await card.getByRole('button', { name: '+ wariant' }).click()
  await card.getByLabel('Wariant 2', { exact: true }).fill('L')
  await card.getByRole('group', { name: 'Dostępne w konkurencjach' }).getByRole('button', { name: 'Bieg 3 km' }).click()
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
  // Tiered after publish, LOCAL only: a paid publish is refused while PAID_REGISTRATION_ENABLED is false.
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
  // A tiered event takes money: while PAID_REGISTRATION_ENABLED is false, „Opublikuj zmiany” says
  // so and applies nothing (Task 3's flag gate). The staged tier-2 change is applied the way
  // V-17 does it, through publish_registration_changes (LOCAL only).
  await dialog.getByRole('button', { name: 'Opublikuj', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Nie można opublikować: płatności online — wkrótce.')
  await dialog.getByRole('button', { name: 'Anuluj' }).click()
  expect(await amountsOf(event.eventId, categoryId)).toEqual([6000, 7000, 8000])
  const { error: applyError } = await db().rpc('publish_registration_changes', {
    p_event_id: event.eventId, p_actor: owner.profileId, p_expected_updated_at: null,
  })
  expect(applyError).toBeNull()
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
