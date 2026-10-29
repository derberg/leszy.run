import crypto from 'node:crypto'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, sessionFor } from '../helpers/stack.js'
import { clearMessages, lastCodeFor, messagesTo } from '../helpers/emailCapture.js'
import { callFn, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import { dpayReset, dpayTransactions, payMock } from '../helpers/dpayControl.js'
import { startScratchHost } from '../helpers/hostPull.js'

// Plan 3, task 9: the paid checkout RA2 → RA4 → dpay (the mock, never real
// dpay) → the order page, the public start list and the organizer's counts,
// across audiences: P-46…P-50 in docs/registration/scenario-matrix.md. The
// runner, the organizer (owner) and an anonymous viewer each have their own
// browser context.

const ZT = '00000000-0000-4000-8000-0000000000c1'
const BIEG = { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }
// functions.env sends dpay back to PUBLIC_SITE_URL (5173); this suite's Vite runs on 5174.
const SITE = 'http://localhost:5173'
// helpers/orders.js imports money.js, which Playwright's loader reads as CommonJS.
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

async function offline(page) {
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  // The mock sends the payer back to PUBLIC_SITE_URL (5173) with a 303, and a route never sees a
  // redirect's target: the pay/decline POST is carried out here and its redirect sent to 5174.
  await page.route(/localhost:54398\/pay\/[^/]+\/(paid|declined)$/, async (route) => {
    const res = await route.fetch({ maxRedirects: 0 })
    const to = (res.headers().location ?? '').replace(SITE, 'http://localhost:5174')
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(to)})</script>` })
  })
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

async function fillPerson(page, { first, last, email }) {
  await page.locator('#p-first').fill(first)
  await page.locator('#p-last').fill(last)
  await page.locator('#p-birth').fill('1990-04-12')
  await page.getByRole('button', { name: 'Kobieta', exact: true }).click()
  await page.locator('#p-email').fill(email)
  await page.locator('#p-phone').fill('600100200')
}

async function tickAll(page) {
  const boxes = page.getByTestId('consents').getByRole('checkbox')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
}

/** RA1 → RA2 → the code → RA4, for a runner the page does not know. */
async function toCheckout(page, event, person) {
  await page.goto(`/events/${event.slug}`)
  await page.getByTestId('competition').filter({ hasText: 'Bieg 9 km' }).click()
  await fillPerson(page, person)
  await tickAll(page)
  await expect(page.getByTestId('registration-submit')).toHaveText('Dalej')
  await page.getByTestId('registration-submit').click()
  await expect(page.getByTestId('code-step')).toBeVisible()
  await page.getByLabel('Kod (6 cyfr)').fill(await codeFor(person.email))
  await page.getByRole('button', { name: 'Dalej' }).click()
  await expect(page.getByTestId('checkout')).toBeVisible()
}

async function orderOf(email) {
  const { data, error } = await admin().from('orders').select('*').eq('buyer_email', email)
  if (error) throw error
  expect(data).toHaveLength(1)
  return data[0]
}

async function latestTxn(orderId) {
  const { data } = await admin().from('payment_attempts').select('dpay_transaction_id, created_at')
    .eq('order_id', orderId).order('created_at', { ascending: false }).limit(1)
  return data[0].dpay_transaction_id
}

const listHeader = (page) => page.getByTestId('start-list-header')

test.describe.serial('a runner pays for „Bieg 9 km” while the organizer and a viewer watch', () => {
  let event, orderId, buyerCookies
  const runner = { first: 'Ola', last: 'Płacąca', email: runnerEmail('pay') }
  // Each test gets fresh contexts: the buyer's session (opened by the code step) is carried over.
  const asBuyer = async (actors) => {
    await actors.runner.addCookies(buyerCookies)
    return offline(await actors.runner.newPage())
  }

  test('P-46 the list starts empty; RA4 holds „Zapłać” until the support choice; „Nie tym razem” → 60,55 zł → the mock page', async ({ actors }) => {
    event = await createPublishedPaidEvent(owner, { competitions: [BIEG], prices: { 'Bieg 9 km': 6000 } })
    await clearMessages()

    const viewer = await offline(await actors.viewer.newPage())
    await viewer.goto(`/events/${event.slug}`)
    await expect(viewer.getByText('Do płatności doliczamy jej koszt (0,9%)')).toBeVisible()
    await viewer.getByTestId('start-list-link').click()
    await expect(viewer).toHaveURL(new RegExp(`/events/${event.slug}/lista$`))
    await expect(listHeader(viewer)).toHaveText('0 opłaconych · 0 czeka na wpłatę')
    await expect(viewer.getByTestId('start-list-empty')).toBeVisible()

    const page = await offline(await actors.runner.newPage())
    await toCheckout(page, event, runner)
    const choice = page.getByTestId('support-choice')
    await expect(choice).toContainText('Wesprzesz LESZY.RUN 2%? Z tego utrzymujemy stronę, zapisy i kalendarz.')
    const yes = choice.getByRole('button', { name: 'Wspieram · 1,20 zł' })
    const no = choice.getByRole('button', { name: 'Nie tym razem' })
    await expect(yes).toHaveAttribute('aria-pressed', 'false')
    await expect(no).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('pay')).toBeDisabled()
    await expect(page.getByTestId('support-hint')).toHaveText('* wybierz, czy wspierasz LESZY.RUN')
    await expect(page.getByTestId('checkout-line')).toContainText('Ola Płacąca')
    await expect(page.getByTestId('checkout-line')).toContainText('Bieg 9 km')
    await expect(page.getByTestId('checkout-amounts')).toContainText('Opłaty startowe')
    await expect(page.getByTestId('checkout-amounts')).toContainText('Obsługa płatności dpay · 0,9%')

    await no.click()
    await expect(no).toHaveAttribute('aria-pressed', 'true')
    await expect(yes).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('checkout-total')).toHaveText(/Razem\s*60,55 zł/)
    await expect(page.getByTestId('support-hint')).toHaveCount(0)
    await expect(page.getByTestId('pay')).toBeEnabled()
    await page.getByTestId('pay').click()
    await expect(page).toHaveURL(/localhost:54398\/pay\//)
    await expect(page.getByRole('heading', { name: 'dpay (mock)' })).toBeVisible()
    await expect(page.getByTestId('amount')).toHaveText('60.55')

    const order = await orderOf(runner.email)
    orderId = order.id
    buyerCookies = (await page.context().cookies()).filter((c) => c.name === 'leszy_session')
    expect(order.support_choice).toBe(false)
    expect(order.total).toBe(6055)
  })

  test('P-47 the runner leaves unpaid: „czeka na wpłatę” on the list, „0 opłaconych · 1 czeka na wpłatę” for the viewer and the owner', async ({ actors }) => {
    const page = await asBuyer(actors)
    await page.goto(`/zamowienie/${orderId}`)
    await expect(page.getByTestId('order-pending')).toBeVisible()
    await expect(page.getByTestId('order-deadline')).toContainText('Opłać do ')
    await expect(page.getByTestId('order-pay')).toHaveText('Zapłać')
    await expect(page.getByTestId('order-person')).toContainText('Ola Płacąca')

    const viewer = await offline(await actors.viewer.newPage())
    await viewer.goto(`/events/${event.slug}/lista`)
    await expect(listHeader(viewer)).toHaveText('0 opłaconych · 1 czeka na wpłatę')
    const entry = viewer.getByTestId('start-list-entry')
    await expect(entry).toHaveCount(1)
    await expect(entry).toContainText('Ola Płacąca')
    await expect(entry.getByTestId('payment-badge')).toHaveText(/czeka na wpłatę/i)
    // Nothing personal and no bib on the public list.
    const text = await viewer.getByTestId('start-list').innerText()
    expect(text).not.toContain(runner.email)
    expect(text).not.toContain('1990')
    expect(text).not.toMatch(/numer startowy|nr startowy|bib/i)

    const org = await offline(await actors.owner.newPage())
    await org.goto(`/klub/zatyrani-test/wydarzenia/${event.eventId}/zgloszenia`)
    await expect(org.getByTestId('registrations-counts')).toHaveText('0 opłaconych · 1 czeka na wpłatę')
    await expect(org.getByTestId('registration-payment')).toContainText('czeka na wpłatę do ')
  })

  test('P-48 the IPN pays it: „OPŁACONE · 60,55 zł”, the list flips, the owner counts 1, the e-mail, the participant reaches the host', async ({ actors }) => {
    await payMock(await latestTxn(orderId), 'paid')

    const page = await asBuyer(actors)
    await page.goto(`/zamowienie/${orderId}`)
    await expect(page.getByTestId('order-paid')).toBeVisible()
    await expect(page.getByTestId('order-paid-label')).toHaveText(/Opłacone · 60,55 zł/i)
    await expect(page.getByText('Jesteście na liście')).toBeVisible()
    await expect(page.getByTestId('order-person')).toContainText('Bieg 9 km')
    await expect(page.getByTestId('order-person')).toContainText('start 10:00')
    await expect(page.getByText(/numer startowy|nr startowy|\bbib\b/i)).toHaveCount(0)

    const viewer = await offline(await actors.viewer.newPage())
    await viewer.goto(`/events/${event.slug}/lista`)
    await expect(listHeader(viewer)).toHaveText('1 opłaconych · 0 czeka na wpłatę')
    await expect(viewer.getByTestId('payment-badge')).toHaveText(/opłacone/i)

    const org = await offline(await actors.owner.newPage())
    await org.goto(`/klub/zatyrani-test/wydarzenia/${event.eventId}/zgloszenia`)
    await expect(org.getByTestId('registrations-counts')).toHaveText('1 opłaconych · 0 czeka na wpłatę')

    await expect.poll(async () => (await messagesTo(runner.email)).map((m) => m.subject).join('|')).toMatch(/Opłacone — /)

    const { data: regs } = await admin().from('registrations').select('id, status').eq('order_id', orderId)
    expect(regs).toEqual([{ id: regs[0].id, status: 'confirmed' }])
    const { data: part } = await admin().from('participants').select('first_name, registration_id, bib_number')
      .eq('registration_id', regs[0].id).single()
    expect(part).toEqual({ first_name: 'Ola', registration_id: regs[0].id, bib_number: null })
    const host = await startScratchHost()
    try {
      await host.pull()
      const rows = await host.sql`select first_name, registration_id from participants where event_id = ${event.eventId}`
      expect(rows.map((r) => ({ ...r }))).toEqual([{ first_name: 'Ola', registration_id: regs[0].id }])
    } finally {
      await host.stop()
    }
  })

  test('P-49 a second runner picks „Wspieram”: 61,76 zł; declines at the mock, „Zapłać” again works', async ({ actors }) => {
    const second = { first: 'Ewa', last: 'Wspierająca', email: runnerEmail('support') }
    const page = await offline(await actors.runner.newPage())
    await toCheckout(page, event, second)
    await page.getByTestId('support-choice').getByRole('button', { name: 'Wspieram · 1,20 zł' }).click()
    await expect(page.getByTestId('checkout-amounts')).toContainText('Wsparcie LESZY.RUN')
    await expect(page.getByTestId('checkout-total')).toHaveText(/Razem\s*61,76 zł/)
    await page.getByTestId('pay').click()
    await expect(page.getByTestId('amount')).toHaveText('61.76')
    const order = await orderOf(second.email)
    expect([order.support_choice, order.support_fee, order.payment_fee, order.total]).toEqual([true, 120, 56, 6176])

    await page.getByRole('button', { name: 'Odrzuć (mock)' }).click()
    await expect(page).toHaveURL(new RegExp(`localhost:5174/zamowienie/${order.id}$`))
    await expect(page.getByTestId('order-pending')).toBeVisible()
    await page.getByTestId('order-pay').click()
    await expect(page).toHaveURL(/localhost:54398\/pay\//)
    const { data: attempts } = await admin().from('payment_attempts').select('id').eq('order_id', order.id)
    expect(attempts).toHaveLength(2)
    await page.getByRole('button', { name: 'Zapłać (mock)' }).click()
    await expect(page).toHaveURL(new RegExp(`localhost:5174/zamowienie/${order.id}$`))
    await expect(page.getByTestId('order-paid-label')).toHaveText(/Opłacone · 61,76 zł/i)
    expect((await dpayTransactions()).filter((t) => t.status === 'paid')).toHaveLength(2)
  })
})

test('P-50 an unpaid order expires: „Zgłoszenie wygasło”, the runner leaves the list, the slot comes back', async ({ actors }) => {
  const event = await createPublishedPaidEvent(owner, { competitions: [BIEG], prices: { 'Bieg 9 km': 6000 } })
  await clearMessages()
  const runner = { first: 'Iga', last: 'Spóźniona', email: runnerEmail('late') }
  const page = await offline(await actors.runner.newPage())
  await toCheckout(page, event, runner)
  await page.getByTestId('support-choice').getByRole('button', { name: 'Nie tym razem' }).click()
  await page.getByTestId('pay').click()
  await expect(page).toHaveURL(/localhost:54398\/pay\//)
  const order = await orderOf(runner.email)
  const taken = async () => (await admin().from('competitions').select('taken').eq('category_id', event.categoryIds[0]).single()).data.taken
  expect(await taken()).toBe(1)

  // A 1 h window, and the job running two hours later.
  const db = admin()
  await db.from('orders').update({ expires_at: new Date(Date.now() + 3600_000).toISOString() }).eq('id', order.id)
  const r = await db.rpc('expire_orders', { p_now: new Date(Date.now() + 2 * 3600_000).toISOString() })
  expect(r.error).toBeNull()

  await page.goto(`/zamowienie/${order.id}`)
  await expect(page.getByTestId('order-ended')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Zgłoszenie wygasło' }).or(page.getByText('Zgłoszenie wygasło'))).toBeVisible()
  await expect(page.getByTestId('order-again')).toHaveText('Zapisz się ponownie')
  await expect(page.getByTestId('order-again')).toHaveAttribute('href', `/events/${event.slug}`)

  const viewer = await offline(await actors.viewer.newPage())
  await viewer.goto(`/events/${event.slug}/lista`)
  await expect(listHeader(viewer)).toHaveText('0 opłaconych · 0 czeka na wpłatę')
  await expect(viewer.getByTestId('start-list-entry')).toHaveCount(0)
  expect(await taken()).toBe(0)
})

test('P-46 RA4 and the order page fit 390 px: no sideways scroll, no wrapped button', async ({ actors }) => {
  const event = await createPublishedPaidEvent(owner, { competitions: [BIEG], prices: { 'Bieg 9 km': 6000 } })
  await clearMessages()
  const page = await offline(await actors.runner.newPage())
  await page.setViewportSize({ width: 390, height: 844 })
  await toCheckout(page, event, { first: 'Ala', last: 'Wąska', email: runnerEmail('narrow') })
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  expect(await fits()).toBe(true)
  for (const name of ['Wspieram · 1,20 zł', 'Nie tym razem']) {
    const box = await page.getByRole('button', { name }).boundingBox()
    expect(box.height).toBeLessThan(60)
  }
  await page.getByRole('button', { name: 'Nie tym razem' }).click()
  await page.getByTestId('pay').click()
  await expect(page).toHaveURL(/localhost:54398\/pay\//)
  await page.goto(`/zamowienie/${(await orderOf((await admin().from('orders').select('buyer_email').eq('event_id', event.eventId).single()).data.buyer_email)).id}`)
  await expect(page.getByTestId('order-pending')).toBeVisible()
  expect(await fits()).toBe(true)
})
