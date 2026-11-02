import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { lastCodeFor } from '../helpers/emailCapture.js'
import { callFn, createPublishedFreeEvent, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import { dpayReset } from '../helpers/dpayControl.js'
import { DPAY_MOCK_PORT } from '../helpers/dpayMock.js'
import { makeExtra, makeVoucher, setCharity } from '../helpers/cart.js'

// Plan 7, task 8a: the runner's cart. RA1 lists each competition's extras, RA2 takes a discount
// code („Sprawdź”, check-voucher) and the extras per person, RA4 shows the voucher line, the
// extras under the person, the donation chips and the summary lines, and its total is
// cartAmounts'. A total above 0 goes to create-order, a free event with nothing picked to
// register-free. RB1 takes the team line's code and each member's extras. Scenarios V-60…V-62, V-61b,
// V-66 (RA2, RA4), V-68 (the form's fallback) and V-85 in docs/registration/scenario-matrix.md.

const ZT = '00000000-0000-4000-8000-0000000000c1'
const NINE = { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }
const THREE = { name: 'Bieg 3 km', discipline: 'run', distanceLabel: '3 km', startTime: '11:00', capacity: 50 }
const PAY_PAGE = new RegExp(`localhost:${DPAY_MOCK_PORT}\\/pay\\/`)
const PRICING = fileURLToPath(new URL('../../../supabase/functions/_shared/registration/pricing.js', import.meta.url))

/**
 * cartAmounts (pricing.js), the function create-order prices with. Run in plain Node: Playwright's
 * loader reads the shared ESM module as CommonJS.
 */
function cartAmounts(cart) {
  const script = `const { cartAmounts } = await import(${JSON.stringify(PRICING)}); process.stdout.write(JSON.stringify(cartAmounts(${JSON.stringify(cart)})))`
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
}

const runnerEmail = (tag) => `runner-${tag}-${crypto.randomBytes(4).toString('hex')}@test.local`

let owner

test.beforeAll(async () => {
  owner = await sessionFor(ACTOR_EMAILS.owner)
  const status = await callFn('organizer-status', owner, { clubId: ZT })
  if (!status.body.data.agreementAccepted) {
    await callFn('accept-organizer-agreement', owner, { clubId: ZT, version: status.body.data.version })
  }
  await dpayReset()
})
test.beforeEach(async () => { await resetThrottle() })

async function offline(page) {
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  return page
}

async function codeFor(email) {
  for (let i = 0; i < 40; i++) {
    const code = await lastCodeFor(email)
    if (code) return code
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`no code e-mail for ${email}`)
}

async function fillPerson(page, { first = 'Ola', last = 'Leśna', email, prefix = 'p', birth = '1990-04-12', gender = 'Kobieta' }) {
  await page.locator(`#${prefix}-first`).fill(first)
  await page.locator(`#${prefix}-last`).fill(last)
  await page.locator(`#${prefix}-birth`).fill(birth)
  const card = prefix === 'p' ? page : page.getByTestId('person-card')
  await card.getByRole('button', { name: gender, exact: true }).click()
  await page.locator(`#${prefix}-email`).fill(email)
  await page.locator(`#${prefix}-phone`).fill('600100200')
}

async function tickAll(page) {
  const boxes = page.getByTestId('consents').getByRole('checkbox')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
}

/** „Dalej” → the e-mail code → RA4. */
async function codeToCheckout(page, email) {
  await page.getByTestId('registration-submit').click()
  await expect(page.getByTestId('code-step')).toBeVisible()
  await page.getByLabel('Kod (6 cyfr)').fill(await codeFor(email))
  await page.getByRole('button', { name: 'Dalej' }).click()
  await expect(page.getByTestId('checkout')).toBeVisible()
}

/** Nothing scrolls sideways, and no button label is cut or wraps (V-66). */
async function fitsNarrow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const overflowing = await page.evaluate(() => [...document.querySelectorAll('#main-content button, #main-content a')]
    .filter((el) => el.offsetParent && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1))
    .map((el) => el.textContent.trim()))
  expect(overflowing).toEqual([])
  for (const b of await page.locator('#main-content button:visible').all()) {
    const box = await b.boundingBox()
    if (box) expect(box.height, await b.textContent()).toBeLessThan(60)
  }
}

/** An input's error is the element its aria-describedby names, with that text. */
async function errorOf(page, selector, text) {
  const input = page.locator(selector)
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  const id = await input.getAttribute('aria-describedby')
  expect(id).toBeTruthy()
  await expect(page.locator(`[id="${id}"]`)).toHaveText(text)
}

async function charityEvent() {
  const event = await createPublishedPaidEvent(owner, { competitions: [NINE, THREE], prices: { 'Bieg 9 km': 6000, 'Bieg 3 km': 2000 } })
  await setCharity(event.eventId, true)
  await admin().from('registration_settings').update({ charity_goal: 'Rehabilitacja Zosi' }).eq('event_id', event.eventId)
  const shirt = await makeExtra(event, { name: 'Koszulka', price: 4500, variants: [['S', 0], ['M', 10]] })
  const cap = await makeExtra(event, { name: 'Czapka', price: 3000, variants: [['L', 0]] })
  const medal = await makeExtra(event, { name: 'Medal', price: 2000, variants: [['Medal', 30]], categoryIds: [event.categoryIds[0]] })
  return { ...event, shirt, cap, medal }
}

const ordersOf = async (email) => (await admin().from('orders').select('*').eq('buyer_email', email)).data

test('RA1 lists the extras of each competition; a sold-out one reads „brak”', async ({ actors }) => {
  const event = await charityEvent()
  const page = await offline(await actors.viewer.newPage())
  await page.goto(`/events/${event.slug}`)
  const nine = page.getByTestId('competition').filter({ hasText: 'Bieg 9 km' })
  const three = page.getByTestId('competition').filter({ hasText: 'Bieg 3 km' })
  // In the organizer's order (sort_order, then id): compared as sets.
  await expect(nine.getByTestId('competition-extra')).toHaveCount(3)
  expect((await nine.getByTestId('competition-extra').allTextContents()).sort()).toEqual(['Czapka · brak', 'Koszulka 45,00 zł', 'Medal 20,00 zł'])
  await expect(three.getByTestId('competition-extra')).toHaveCount(2)
  expect((await three.getByTestId('competition-extra').allTextContents()).sort()).toEqual(['Czapka · brak', 'Koszulka 45,00 zł'])
})

for (const width of [1440, 390]) {
  test(`V-61 ${width} px: a code, a shirt and +10 zł → RA4's lines and total are cartAmounts', the order and dpay charge it`, async ({ actors }) => {
    const event = await charityEvent()
    const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 5, code: `BIEGACZ-${crypto.randomBytes(2).toString('hex').toUpperCase()}` })
    const email = runnerEmail('cart')
    const page = await offline(await actors.viewer.newPage())
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/events/${event.slug}`)
    await page.getByTestId('competition').filter({ hasText: 'Bieg 9 km' }).click()
    await fillPerson(page, { email })

    // A wrong code first: the error sits under the field and is linked to it.
    await page.getByLabel('Kod rabatowy').fill('ZLY-KOD-1')
    await page.getByRole('button', { name: 'Sprawdź' }).click()
    await errorOf(page, '#p-voucher', 'Nieprawidłowy kod.')
    // The right one, typed in lower case.
    await page.getByLabel('Kod rabatowy').fill(voucher.code.toLowerCase())
    await page.getByRole('button', { name: 'Sprawdź' }).click()
    await expect(page.getByTestId('voucher-ok')).toHaveText(`60,00 zł − 15% (${voucher.code}) = 51,00 zł`)

    const shirt = page.getByTestId('extra').filter({ hasText: 'Koszulka' })
    await shirt.getByLabel('Wariant').selectOption({ label: 'M' })
    await shirt.getByLabel('Ilość').selectOption('1')
    await tickAll(page)
    if (width === 390) await fitsNarrow(page)
    await codeToCheckout(page, email)

    const line = page.getByTestId('checkout-line')
    await expect(line).toContainText('Ola Leśna')
    await expect(line.getByTestId('checkout-voucher')).toHaveText(`60,00 zł − 15% (${voucher.code}) = 51,00 zł`)
    await expect(line.getByTestId('checkout-line-price')).toHaveText('51,00 zł')
    await expect(line.getByTestId('checkout-extra')).toHaveText(['Koszulka · M · 45,00 zł'])
    await expect(page.getByTestId('donation')).toContainText('Dodatkowa darowizna na cel: Rehabilitacja Zosi')
    await expect(page.getByTestId('donation-info')).toHaveText('Darowizna to dodatkowa kwota ponad opłatę startową. Przekazujemy ją organizatorowi w całości, na ten cel.')
    await expect(page.getByTestId('donation').getByRole('radio')).toHaveText(['0', '+5 zł', '+10 zł', 'inna'])
    await expect(page.getByRole('radio', { name: '0', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('radio', { name: '+10 zł' }).click()

    const expected = cartAmounts({ people: [{ listPrice: 6000, voucherPercent: 15, extras: [{ price: 4500, qty: 1 }] }], donation: 1000 })
    expect(expected.total).toBe(10600)
    await expect(page.getByTestId('amount-entries')).toHaveText(/Opłaty startowe\s*51,00 zł/)
    await expect(page.getByTestId('amount-extras')).toHaveText(/Dodatki\s*45,00 zł/)
    await expect(page.getByTestId('amount-donation')).toHaveText(/Dodatkowa darowizna na cel\s*10,00 zł/)
    await expect(page.getByTestId('checkout-total')).toHaveText(/Razem\s*106,00 zł/)
    if (width === 390) await fitsNarrow(page)

    await page.getByTestId('pay').click()
    await expect(page).toHaveURL(PAY_PAGE)
    await expect(page.getByTestId('amount')).toHaveText('106.00')
    const [order] = await ordersOf(email)
    expect([order.entry_total, order.extras_total, order.donation, order.total])
      .toEqual([expected.entryTotal, expected.extrasTotal, expected.donation, expected.total])
  })
}

test('V-60 „inna” on RA4: 0 is refused under the field and „Zapłać” waits; 12,5 zł counts as 12,50 zł', async ({ actors }) => {
  const event = await charityEvent()
  const email = runnerEmail('inna')
  const page = await offline(await actors.viewer.newPage())
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto(`/events/${event.slug}`)
  await page.getByTestId('competition').filter({ hasText: 'Bieg 3 km' }).click()
  await fillPerson(page, { email })
  await tickAll(page)
  await codeToCheckout(page, email)

  await page.getByRole('radio', { name: 'inna' }).click()
  await page.getByLabel('Kwota darowizny (zł)').fill('0')
  await errorOf(page, '#donation-other', 'Popraw kwotę darowizny.')
  await expect(page.getByTestId('pay')).toBeDisabled()
  await page.getByLabel('Kwota darowizny (zł)').fill('5 000,01')
  await errorOf(page, '#donation-other', 'Popraw kwotę darowizny.')
  await page.getByLabel('Kwota darowizny (zł)').fill('12,5')
  await expect(page.locator('#donation-other')).not.toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByTestId('amount-donation')).toHaveText(/Dodatkowa darowizna na cel\s*12,50 zł/)
  await expect(page.getByTestId('checkout-total')).toHaveText(/Razem\s*32,50 zł/)
  await fitsNarrow(page)
  await page.getByTestId('pay').click()
  await expect(page).toHaveURL(PAY_PAGE)
  const [order] = await ordersOf(email)
  expect([order.donation, order.total]).toEqual([1250, 3250])
})

test('V-62 a sold-out variant reads „brak” and cannot be picked; an extra with nothing left cannot be ordered', async ({ actors }) => {
  const event = await charityEvent()
  const page = await offline(await actors.viewer.newPage())
  await page.goto(`/events/${event.slug}`)
  await page.getByTestId('competition').filter({ hasText: 'Bieg 9 km' }).click()
  const shirt = page.getByTestId('extra').filter({ hasText: 'Koszulka' })
  const s = shirt.getByLabel('Wariant').locator('option', { hasText: 'S' })
  await expect(s).toHaveText('S · brak')
  await expect(s).toBeDisabled()
  await expect(shirt.getByLabel('Wariant')).toHaveValue(event.shirt.variants.M.id)
  const cap = page.getByTestId('extra').filter({ hasText: 'Czapka' })
  await expect(cap.getByTestId('extra-sold-out')).toHaveText('brak')
  await expect(cap.getByRole('combobox')).toHaveCount(0)
  // The medal is offered only in „Bieg 9 km”.
  await expect(page.getByTestId('extra').filter({ hasText: 'Medal' })).toHaveCount(1)
})

test('a free event: a shirt makes it an order (create-order → dpay); nothing picked registers free', async ({ actors }) => {
  const event = await createPublishedFreeEvent(owner, { competitions: [NINE] })
  await makeExtra(event, { name: 'Koszulka', price: 4500, variants: [['M', 10]] })

  const buyer = runnerEmail('freeshirt')
  const page = await offline(await actors.viewer.newPage())
  await page.goto(`/events/${event.slug}`)
  await page.getByTestId('competition').filter({ hasText: 'Bieg 9 km' }).click()
  await fillPerson(page, { email: buyer })
  // No code field: there is no fee to discount.
  await expect(page.getByLabel('Kod rabatowy')).toHaveCount(0)
  await page.getByTestId('extra').getByLabel('Ilość').selectOption('1')
  await tickAll(page)
  await expect(page.getByTestId('registration-submit')).toHaveText('Dalej')
  await codeToCheckout(page, buyer)
  await expect(page.getByTestId('checkout-total')).toHaveText(/Razem\s*45,00 zł/)
  await page.getByTestId('pay').click()
  await expect(page).toHaveURL(PAY_PAGE)
  const [order] = await ordersOf(buyer)
  expect([order.entry_total, order.extras_total, order.total]).toEqual([0, 4500, 4500])

  const plain = runnerEmail('freeplain')
  const other = await offline(await actors.viewer.newPage())
  await other.goto(`/events/${event.slug}`)
  await other.getByTestId('competition').filter({ hasText: 'Bieg 9 km' }).click()
  await fillPerson(other, { email: plain, first: 'Jan', gender: 'Mężczyzna' })
  await tickAll(other)
  await other.getByTestId('registration-submit').click()
  await expect(other.getByTestId('code-step')).toBeVisible()
  await other.getByLabel('Kod (6 cyfr)').fill(await codeFor(plain))
  await other.getByRole('button', { name: 'Zapisz się' }).click()
  await expect(other).toHaveURL(new RegExp(`/events/${event.slug}/zapisano`))
  expect(await ordersOf(plain)).toEqual([])
})

test('a code refused by create-order sends the payer back to that person\'s code field (group of two)', async ({ actors }) => {
  const event = await charityEvent()
  const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 5 })
  const email = runnerEmail('grp')
  const page = await offline(await actors.viewer.newPage())
  await page.goto(`/events/${event.slug}`)
  await page.getByTestId('competition').filter({ hasText: 'Bieg 9 km' }).click()
  await fillPerson(page, { email })
  await page.getByTestId('add-person').click()
  await fillPerson(page, { prefix: 'p2', first: 'Piotr', email: runnerEmail('grp2'), gender: 'Mężczyzna' })
  await page.locator('#p2-voucher').fill(voucher.code)
  await page.getByTestId('person-card').getByRole('button', { name: 'Sprawdź' }).click()
  await expect(page.getByTestId('voucher-ok')).toBeVisible()
  await page.getByTestId('person-done').click()
  await tickAll(page)
  await codeToCheckout(page, email)
  await expect(page.getByTestId('checkout-line').nth(1).getByTestId('checkout-voucher')).toHaveText(`60,00 zł − 15% (${voucher.code}) = 51,00 zł`)
  await expect(page.getByTestId('checkout-total')).toHaveText(/Razem\s*111,00 zł/)

  // The organizer switches the code off meanwhile.
  await admin().from('vouchers').update({ disabled_at: new Date().toISOString() }).eq('id', voucher.id)
  await page.getByTestId('pay').click()
  await expect(page.getByTestId('form-error')).toHaveText('Popraw dane: Piotr Leśna.')
  await errorOf(page, '#p2-voucher', 'Nieprawidłowy kod.')
  expect(await ordersOf(email)).toEqual([])
})

test('a code typed and never checked is checked on „Dalej”: a wrong one stops on the field, a right one reaches RA4 discounted', async ({ actors }) => {
  const event = await charityEvent()
  const voucher = await makeVoucher(event.eventId, { percent: 50, max_uses: 5 })
  const email = runnerEmail('unchecked')
  const page = await offline(await actors.viewer.newPage())
  await page.goto(`/events/${event.slug}`)
  await page.getByTestId('competition').filter({ hasText: 'Bieg 9 km' }).click()
  await fillPerson(page, { email })
  await tickAll(page)
  await page.getByLabel('Kod rabatowy').fill('ZLY-KOD-2')
  await page.getByTestId('registration-submit').click()
  await errorOf(page, '#p-voucher', 'Nieprawidłowy kod.')
  await expect(page.getByTestId('code-step')).toHaveCount(0)
  await expect(page.locator('#p-voucher')).toBeFocused()

  await page.getByLabel('Kod rabatowy').fill(voucher.code)
  await codeToCheckout(page, email)
  await expect(page.getByTestId('checkout-voucher')).toHaveText(`60,00 zł − 50% (${voucher.code}) = 30,00 zł`)
  await expect(page.getByTestId('checkout-total')).toHaveText(/Razem\s*30,00 zł/)
})

// ---------------------------------------------------------------- fix round 1

test('I-1 a 429 or no connection from check-voucher does not hold „Dalej”: create-order decides the code', async ({ actors }) => {
  const event = await charityEvent()
  const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 5 })
  const email = runnerEmail('throttled')
  const page = await offline(await actors.viewer.newPage())
  let answer = 'abort'
  await page.route('**/edge/check-voucher', (route) => (answer === 'abort'
    ? route.abort()
    : route.fulfill({ status: 429, contentType: 'application/json', headers: { 'retry-after': '3600' }, body: JSON.stringify({ error: 'Zbyt wiele prób. Spróbuj ponownie później.' }) })))
  await page.goto(`/events/${event.slug}`)
  await page.getByTestId('competition').filter({ hasText: 'Bieg 9 km' }).click()
  await fillPerson(page, { email })
  await page.getByLabel('Kod rabatowy').fill(voucher.code)
  // No connection on „Sprawdź”: a note, not an error.
  await page.getByRole('button', { name: 'Sprawdź' }).click()
  await expect(page.getByTestId('voucher-note')).toHaveText('Nie udało się połączyć. Spróbuj ponownie.')
  await expect(page.locator('#p-voucher')).not.toHaveAttribute('aria-invalid', 'true')
  // A 429 on „Dalej”: the form goes on to the e-mail code all the same.
  answer = '429'
  await tickAll(page)
  await codeToCheckout(page, email)
  // RA4 could not apply the code; create-order does, and answers with its price.
  await expect(page.getByTestId('checkout-total')).toHaveText(/Razem\s*60,00 zł/)
  await page.getByTestId('pay').click()
  await expect(page.getByRole('alert')).toHaveText('Cena się zmieniła. Sprawdź podsumowanie.')
  await expect(page.getByTestId('checkout-total')).toHaveText(/Razem\s*51,00 zł/)
  await page.getByTestId('pay').click()
  await expect(page).toHaveURL(PAY_PAGE)
  const [order] = await ordersOf(email)
  expect(order.total).toBe(5100)
})

test('I-1 a code check-voucher could not judge, and that is wrong, comes back from create-order onto the field', async ({ actors }) => {
  const event = await charityEvent()
  const email = runnerEmail('throttledbad')
  const page = await offline(await actors.viewer.newPage())
  await page.route('**/edge/check-voucher', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Zbyt wiele prób. Spróbuj ponownie później.' }) }))
  await page.goto(`/events/${event.slug}`)
  await page.getByTestId('competition').filter({ hasText: 'Bieg 9 km' }).click()
  await fillPerson(page, { email })
  await page.getByLabel('Kod rabatowy').fill('ZLY-KOD-3')
  await tickAll(page)
  await codeToCheckout(page, email)
  await page.getByTestId('pay').click()
  await errorOf(page, '#p-voucher', 'Nieprawidłowy kod.')
  expect(await ordersOf(email)).toEqual([])
})

test('I-2 a code typed on a card that then moves to a 0 zł competition is dropped with its field; the order carries no code', async ({ actors }) => {
  const event = await createPublishedPaidEvent(owner, { competitions: [NINE, THREE], prices: { 'Bieg 9 km': 6000, 'Bieg 3 km': 0 } })
  const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 5 })
  const email = runnerEmail('zero')
  const page = await offline(await actors.viewer.newPage())
  await page.goto(`/events/${event.slug}`)
  await page.getByTestId('competition').filter({ hasText: 'Bieg 9 km' }).click()
  await fillPerson(page, { email })
  await page.getByTestId('add-person').click()
  await fillPerson(page, { prefix: 'p2', first: 'Piotr', email: runnerEmail('zero2'), gender: 'Mężczyzna' })
  await page.locator('#p2-voucher').fill(voucher.code)
  await page.getByTestId('person-card').getByRole('button', { name: 'Sprawdź' }).click()
  await expect(page.getByTestId('voucher-ok')).toBeVisible()
  await page.locator('#p2-competition').selectOption({ label: 'Bieg 3 km · Bezpłatne' })
  await expect(page.locator('#p2-voucher')).toHaveCount(0)
  await page.getByTestId('person-done').click()
  await tickAll(page)
  await codeToCheckout(page, email)
  await expect(page.getByTestId('checkout-voucher')).toHaveCount(0)
  await expect(page.getByTestId('checkout-total')).toHaveText(/Razem\s*60,00 zł/)
  await page.getByTestId('pay').click()
  await expect(page).toHaveURL(PAY_PAGE)
  const [order] = await ordersOf(email)
  const { data: regs } = await admin().from('registrations').select('voucher_id, price').eq('order_id', order.id)
  expect(regs.map((r) => r.voucher_id)).toEqual([null, null])
  expect(order.total).toBe(6000)
})

const STAFETA = { name: 'Sztafeta', discipline: 'run', distanceLabel: '4 x 5 km', startTime: '10:00', capacity: 20, kind: 'team', teamMin: 2, teamMax: 4 }

async function fillMember(page, prefix, { first, last = 'Leśny', birth = '1987-01-01', gender = 'Mężczyzna', email, phone = '600300400' }) {
  await page.locator(`#${prefix}-first`).fill(first)
  await page.locator(`#${prefix}-last`).fill(last)
  await page.locator(`#${prefix}-birth`).fill(birth)
  await page.locator(`[aria-labelledby="${prefix}-gender-label"]`).getByRole('button', { name: gender, exact: true }).click()
  await page.locator(`#${prefix}-email`).fill(email)
  await page.locator(`#${prefix}-phone`).fill(phone)
}

for (const width of [1440, 390]) {
  test(`RB1 ${width} px: the team code on the captain's step, a member's shirt → RB3's fee line and total are cartAmounts', register-team charges it`, async ({ actors }) => {
    const event = await createPublishedPaidEvent(owner, { competitions: [STAFETA], prices: { Sztafeta: 24000 } })
    await makeExtra(event, { name: 'Koszulka', price: 4500, variants: [['S', 0], ['M', 10]] })
    const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 5 })
    const teamName = `Wilcze Stado ${crypto.randomBytes(4).toString('hex')}`
    const page = await offline(await actors.runner.newPage())
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/events/${event.slug}`)
    // RA1 lists the shirt under the team competition, and the team form now sells it.
    await expect(page.getByTestId('competition-extra')).toHaveText(['Koszulka 45,00 zł'])
    await page.getByTestId('competition').first().click()
    await page.getByLabel('Nazwa drużyny').fill(teamName)
    await fillMember(page, 'p', { first: 'Ola', last: 'Leśna', birth: '1988-03-01', gender: 'Kobieta', email: ACTOR_EMAILS.runner, phone: '600100200' })
    await page.getByLabel('Kod rabatowy').fill(voucher.code)
    await page.getByRole('button', { name: 'Sprawdź' }).click()
    await expect(page.getByTestId('voucher-ok')).toHaveText(`240,00 zł − 15% (${voucher.code}) = 204,00 zł`)
    await tickAll(page)
    if (width === 390) await fitsNarrow(page)
    await page.getByRole('button', { name: 'Dalej: skład' }).click()
    await expect(page.getByTestId('member-card')).toBeVisible()
    await fillMember(page, 'p2', { first: 'Piotr', email: runnerEmail('piotr') })
    const shirt = page.getByTestId('member-card').getByTestId('extra')
    await shirt.getByLabel('Wariant').selectOption({ label: 'M' })
    await shirt.getByLabel('Ilość').selectOption('1')
    if (width === 390) await fitsNarrow(page)
    await page.getByTestId('person-done').click()
    await page.getByTestId('members-consent').check()
    await page.getByRole('button', { name: 'Dalej: płatność' }).click()

    const expected = cartAmounts({ people: [{ listPrice: 24000, voucherPercent: 15, extras: [{ price: 4500, qty: 1 }] }], donation: 0 })
    expect(expected.total).toBe(24900)
    await expect(page.getByTestId('checkout-voucher')).toHaveText(`240,00 zł − 15% (${voucher.code}) = 204,00 zł`)
    await expect(page.getByTestId('checkout-line-price')).toHaveText('204,00 zł')
    await expect(page.getByTestId('team-member').nth(1).getByTestId('checkout-extra')).toHaveText(['Koszulka · M · 45,00 zł'])
    await expect(page.getByTestId('checkout-extra')).toHaveCount(1)
    await expect(page.getByTestId('amount-entries')).toHaveText(/Opłaty startowe\s*204,00 zł/)
    await expect(page.getByTestId('amount-extras')).toHaveText(/Dodatki\s*45,00 zł/)
    await expect(page.getByTestId('checkout-total')).toHaveText(/Razem\s*249,00 zł/)
    if (width === 390) await fitsNarrow(page)
    await page.getByTestId('pay').click()
    await expect(page).toHaveURL(PAY_PAGE)
    await expect(page.getByTestId('amount')).toHaveText('249.00')
    const { data: team } = await admin().from('teams').select('id').eq('name', teamName).single()
    const { data: regs } = await admin().from('registrations').select('order_id, voucher_id, price').eq('team_id', team.id)
    const { data: order } = await admin().from('orders').select('*').eq('id', regs[0].order_id).single()
    expect([order.entry_total, order.extras_total, order.donation, order.total])
      .toEqual([expected.entryTotal, expected.extrasTotal, expected.donation, expected.total])
    expect(regs.filter((r) => r.voucher_id === voucher.id)).toHaveLength(1)
  })
}

test('RB1: a wrong team code stops RB1 on the field; register-team refusing it sends the captain back to it', async ({ actors }) => {
  const event = await createPublishedPaidEvent(owner, { competitions: [STAFETA], prices: { Sztafeta: 24000 } })
  const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 5 })
  const page = await offline(await actors.runner.newPage())
  await page.goto(`/events/${event.slug}`)
  await page.getByTestId('competition').first().click()
  await page.getByLabel('Nazwa drużyny').fill(`Wilcze Stado ${crypto.randomBytes(4).toString('hex')}`)
  await fillMember(page, 'p', { first: 'Ola', last: 'Leśna', birth: '1988-03-01', gender: 'Kobieta', email: ACTOR_EMAILS.runner, phone: '600100200' })
  await page.getByLabel('Kod rabatowy').fill('ZLY-KOD-4')
  await tickAll(page)
  await page.getByRole('button', { name: 'Dalej: skład' }).click()
  await errorOf(page, '#p-voucher', 'Nieprawidłowy kod.')
  await expect(page.getByTestId('member-card')).toHaveCount(0)

  await page.getByLabel('Kod rabatowy').fill(voucher.code)
  await page.getByRole('button', { name: 'Dalej: skład' }).click()
  await fillMember(page, 'p2', { first: 'Piotr', email: runnerEmail('piotr2') })
  await page.getByTestId('person-done').click()
  await page.getByTestId('members-consent').check()
  await page.getByRole('button', { name: 'Dalej: płatność' }).click()
  await expect(page.getByTestId('checkout-total')).toHaveText(/Razem\s*204,00 zł/)
  await admin().from('vouchers').update({ disabled_at: new Date().toISOString() }).eq('id', voucher.id)
  await page.getByTestId('pay').click()
  await expect(page.getByTestId('team-captain')).toBeVisible()
  await errorOf(page, '#p-voucher', 'Nieprawidłowy kod.')
})
