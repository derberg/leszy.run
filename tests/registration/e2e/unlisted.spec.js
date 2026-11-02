import crypto from 'node:crypto'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, sessionFor } from '../helpers/stack.js'
import { clearMessages, lastCodeFor } from '../helpers/emailCapture.js'
import { callFn, createPublishedFreeEvent, makeEventPaid } from '../helpers/registrationFixtures.js'
import { dpayReset, payMock } from '../helpers/dpayControl.js'
import { DPAY_MOCK_PORT } from '../helpers/dpayMock.js'
import { VITE_BASE_PORT, slotPort } from '../helpers/slot.js'

// „Widoczność: Tylko przez link” (W-84, W-85 in docs/registration/scenario-matrix.md): the owner
// publishes a 1 zł event link-only from the Publikacja step. It is on no list, its page says
// noindex, and a runner holding the link registers and pays on the dpay mock.

const ZT = '00000000-0000-4000-8000-0000000000c1'
const SITE = 'http://localhost:5173'
const VITE = `http://localhost:${slotPort(VITE_BASE_PORT)}`
const PAY_PAGE = new RegExp(`localhost:${DPAY_MOCK_PORT}\\/pay\\/`)
const hex = () => crypto.randomBytes(4).toString('hex')

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
  await page.route(new RegExp(`localhost:${DPAY_MOCK_PORT}\\/pay\\/[^/]+\\/(paid|declined)$`), async (route) => {
    const res = await route.fetch({ maxRedirects: 0 })
    const to = (res.headers().location ?? '').replace(SITE, VITE)
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

const visibilityOf = async (eventId) => (await admin().from('events').select('visibility').eq('id', eventId).single()).data.visibility

test.describe.serial('a link-only 1 zł event', () => {
  let event
  const name = `Test płatności 1 zł ${hex()}`

  test('W-84 the owner picks „Tylko przez link” in Publikacja: the badge shows, publish makes it unlisted, the club list marks it', async ({ actors }) => {
    event = await createPublishedFreeEvent(owner, { name, publish: false })
    const page = await offline(await actors.owner.newPage())
    await page.goto(`/klub/zatyrani-test/wydarzenia/${event.eventId}/publikacja`)
    const group = page.getByRole('radiogroup', { name: 'Widoczność' })
    await expect(group.getByRole('radio', { name: 'Publiczne' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('unlisted-badge')).toHaveCount(0)
    await group.getByRole('radio', { name: 'Tylko przez link' }).click()
    await expect(group.getByRole('radio', { name: 'Tylko przez link' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('unlisted-badge')).toHaveText('UKRYTE — TYLKO PRZEZ LINK')
    await expect.poll(async () => (await admin().from('registration_settings').select('listed').eq('event_id', event.eventId).single()).data.listed).toBe(false)

    await page.getByRole('button', { name: /^Opublikuj/ }).click()
    await expect(page.getByTestId('published')).toBeVisible()
    expect(await visibilityOf(event.eventId)).toBe('unlisted')
    const { data: rs } = await admin().from('registration_settings').select('slug').eq('event_id', event.eventId).single()
    event = await makeEventPaid({ ...event, slug: rs.slug }, { prices: { 'Bieg 9 km': 100 } })

    await page.goto('/klub/zatyrani-test/wydarzenia')
    const card = page.getByTestId('event-card').filter({ hasText: name })
    await expect(card.getByTestId('unlisted-badge')).toHaveText('UKRYTE — TYLKO PRZEZ LINK')
    // A listed event of the same club carries no badge.
    const listedName = `Bieg jawny ${hex()}`
    await createPublishedFreeEvent(owner, { name: listedName })
    await page.reload()
    const listedCard = page.getByTestId('event-card').filter({ hasText: listedName })
    await expect(listedCard).toBeVisible()
    await expect(listedCard.getByTestId('unlisted-badge')).toHaveCount(0)
  })

  test('W-84 nobody finds it: not on the home page list, not among the landing page\'s upcoming events', async ({ actors }) => {
    const controlName = `Bieg jawny ${hex()}`
    await createPublishedFreeEvent(owner, { name: controlName })
    const viewer = await offline(await actors.viewer.newPage())
    await viewer.goto('/events')
    await expect(viewer.getByText(controlName)).toBeVisible()
    await expect(viewer.getByText(name)).toHaveCount(0)

    const upcoming = viewer.waitForResponse((r) => r.url().includes('/rest/v1/events') && r.url().includes('visibility=eq.public') && r.url().includes('date=gte'))
    await viewer.goto('/')
    const rows = await (await upcoming).json()
    expect(rows.map((r) => r.slug)).not.toContain(event.slug)
    await expect(viewer.getByText(name)).toHaveCount(0)
  })

  test('W-85 a runner with the link: the page says noindex; registration and the 1 zł payment on the mock go through', async ({ actors }) => {
    await clearMessages()
    const email = `runner-unlisted-${hex()}@test.local`
    const page = await offline(await actors.runner.newPage())
    await page.goto(`/events/${event.slug}`)
    await expect(page.getByTestId('registration-event-page')).toBeVisible()
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow')

    await page.getByTestId('competition').filter({ hasText: 'Bieg 9 km' }).click()
    await page.locator('#p-first').fill('Ola')
    await page.locator('#p-last').fill('Ukryta')
    await page.locator('#p-birth').fill('1990-04-12')
    await page.getByRole('button', { name: 'Kobieta', exact: true }).click()
    await page.locator('#p-email').fill(email)
    await page.locator('#p-phone').fill('600100200')
    const boxes = page.getByTestId('consents').getByRole('checkbox')
    for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
    await page.getByTestId('registration-submit').click()
    await expect(page.getByTestId('code-step')).toBeVisible()
    await page.getByLabel('Kod (6 cyfr)').fill(await codeFor(email))
    await page.getByRole('button', { name: 'Dalej' }).click()
    await expect(page.getByTestId('checkout')).toBeVisible()
    await expect(page.getByTestId('checkout-total')).toHaveText(/Razem\s*1,00 zł/)
    await page.getByTestId('pay').click()
    await expect(page).toHaveURL(PAY_PAGE)
    await expect(page.getByTestId('amount')).toHaveText('1.00')

    const { data: [order] } = await admin().from('orders').select('id, total').eq('buyer_email', email)
    expect(order.total).toBe(100)
    const { data: [attempt] } = await admin().from('payment_attempts').select('dpay_transaction_id')
      .eq('order_id', order.id).order('created_at', { ascending: false }).limit(1)
    await payMock(attempt.dpay_transaction_id, 'paid')
    await page.goto(`/zamowienie/${order.id}`)
    await expect(page.getByTestId('order-paid-label')).toHaveText(/Opłacone · 1,00 zł/i)

    const viewer = await offline(await actors.viewer.newPage())
    await viewer.goto(`/events/${event.slug}/lista`)
    await expect(viewer.getByTestId('start-list-header')).toHaveText('1 opłacone')
  })
})
