import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { sandboxConfig, shapeOf } from './guard.js'

// dpay sandbox acceptance, S-01…S-06 (plan 3, task 10). Real dpay sandbox, the LOCAL Supabase stack, the
// real edge functions and a public tunnel for the IPN. Never in PR CI: see README.md.
// Everything is skipped unless DPAY_ENV=sandbox.

const enabled = process.env.DPAY_ENV === 'sandbox'
const here = path.dirname(fileURLToPath(import.meta.url))
const LOG = path.join(here, '../test-results/sandbox-run-log.json')
const log = { startedAt: new Date().toISOString(), entries: [] }
function record(id, what, data) {
  log.entries.push({ id, what, data })
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  fs.writeFileSync(LOG, JSON.stringify(log, null, 2))
}

const PRICE = 6000
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, { what, timeout = 120_000, every = 2000 }) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await wait(every)
  }
}

test.describe('dpay sandbox acceptance', () => {
  test.skip(!enabled, 'DPAY_ENV is not "sandbox": this suite talks to the dpay sandbox and is run by hand or nightly')
  test.describe.configure({ mode: 'serial' })

  let cfg, h, event

  // The real app code (dpay.js, money.js) runs in a child Node process: see bridge.mjs.
  const bridge = (op, req = {}) => {
    const out = execFileSync('node', [path.join(here, 'bridge.mjs'), op], { input: JSON.stringify(req), encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } })
    const res = JSON.parse(out.trim().split('\n').pop())
    if (res.err) throw Object.assign(new Error(`${op}: ${res.err.message}`), res.err)
    return res.ok
  }
  const rows = async (table, filter) => {
    let q = h.stack.admin().from(table).select('*')
    for (const [k, v] of Object.entries(filter)) q = q.eq(k, v)
    const { data, error } = await q
    if (error) throw error
    return data
  }
  const rand = () => crypto.randomBytes(4).toString('hex')
  const person = (email) => ({
    firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-01-01', gender: 'K', email, phone: '+48500100200', ageGroupLabel: 'K open',
  })

  test.beforeAll(async () => {
    cfg = sandboxConfig() // refuses a production dpay host
    h = {
      stack: await import('../helpers/stack.js'),
      fx: await import('../helpers/registrationFixtures.js'),
    }
    h.stack.localEnv() // refuses anything but the local stack
    await h.stack.resetThrottle()
    await h.fx.acceptAgreement('zatyrani-test')
    const owner = await h.stack.sessionFor('owner@zatyrani-test.local')
    event = await h.fx.createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': PRICE } })
  })

  test.afterAll(() => {
    if (enabled) record('end', 'finished', { at: new Date().toISOString() })
  })

  let TOTAL
  const total = () => (TOTAL ??= bridge('total', { price: PRICE }))

  /** create-order as a fresh runner → { email, runner, orderId, redirectUrl }. */
  async function placeOrder() {
    const email = `runner-sbx-${rand()}@test.local`
    const runner = await h.stack.sessionFor(email)
    const consents = (await rows('event_consents', { event_id: event.eventId })).map((c) => c.id)
    const res = await h.fx.callFn('create-order', runner, {
      categoryId: event.categoryIds[0], person: person(email), acceptedConsentIds: consents, serviceRegulamin: true,
      supportChoice: false, displayedTotal: total(),
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return { email, runner, ...res.body.data }
  }

  // dpay's payment page. Its markup is not documented: the locators below are the first guess and are the
  // part most likely to need adjusting on the first sandbox run (screenshots and a trace are kept on failure).
  async function openGateway(page, redirectUrl) {
    await page.goto(redirectUrl, { waitUntil: 'domcontentloaded' })
  }
  async function payBlik(page) {
    await page.getByText(/blik/i).first().click()
    await page.getByLabel(/kod|blik/i).first().fill(cfg.blikCode)
    await page.getByRole('button', { name: /zapłać|zaplac|pay/i }).first().click()
  }
  async function payCard(page, number = cfg.card.number) {
    await page.getByText(/kart/i).first().click()
    await page.getByLabel(/numer karty|card number/i).first().fill(number)
    await page.getByLabel(/wa[żz]no[śs][ćc]|expir|mm\s*\/\s*yy/i).first().fill(cfg.card.expiry)
    await page.getByLabel(/cvc|cvv/i).first().fill(cfg.card.cvc)
    await page.getByRole('button', { name: /zapłać|zaplac|pay/i }).first().click()
  }

  const orderRow = async (id) => (await rows('orders', { id }))[0]
  const waitPaid = (orderId) => waitFor(async () => (await orderRow(orderId))?.status === 'paid', { what: 'order paid by IPN' })

  /** The assertions S-01 and S-02 share. */
  async function assertPaid(id, orderId) {
    const order = await orderRow(orderId)
    expect(order.status).toBe('paid')
    expect(order.total).toBe(total())
    const registrations = await rows('registrations', { order_id: orderId })
    expect(registrations.length).toBe(1)
    expect((await rows('participants', { registration_id: registrations[0].id })).length).toBe(1)
    const events = (await rows('payment_events', { order_id: orderId })).filter((e) => e.kind === 'ipn' && e.checksum_ok)
    expect(events.length, 'a signed IPN reached the tunnel').toBeGreaterThan(0)
    const raw = events[0].payload?.amount
    // The raw wire format is the finding: it is what parseDpayAmount has to accept.
    record(id, 'ipn amount, raw format', { amount: raw, type: typeof raw, ipnKeys: Object.keys(events[0].payload ?? {}).sort() })
    expect(bridge('parse', { str: String(raw) }).grosze, 'parseDpayAmount accepted the real amount').toBe(total())
  }

  test('S-01 BLIK: pay on the real gateway, the real IPN confirms the order', async ({ page }) => {
    const order = await placeOrder()
    await openGateway(page, order.redirectUrl)
    await payBlik(page)
    await waitPaid(order.orderId)
    await assertPaid('S-01', order.orderId)
  })

  test('S-02 card: pay on the real gateway, the real IPN confirms the order', async ({ page }) => {
    const order = await placeOrder()
    await openGateway(page, order.redirectUrl)
    await payCard(page)
    await waitPaid(order.orderId)
    await assertPaid('S-02', order.orderId)
  })

  test('S-03 a declined payment leaves the order pending; pay-order then pays it', async ({ page }) => {
    test.skip(!cfg.declineCard, 'DPAY_SANDBOX_DECLINE_CARD_NUMBER is not set (a sandbox card number that dpay declines)')
    const order = await placeOrder()
    await openGateway(page, order.redirectUrl)
    await payCard(page, cfg.declineCard)
    await wait(20_000) // the decline has no IPN guarantee: give dpay time, then look
    expect((await orderRow(order.orderId)).status).toBe('pending')

    const again = await h.fx.callFn('pay-order', order.runner, { orderId: order.orderId })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    const page2 = await page.context().newPage()
    await openGateway(page2, again.body.data.redirectUrl)
    await payBlik(page2)
    await waitPaid(order.orderId)
    expect((await rows('payment_attempts', { order_id: order.orderId })).length).toBe(2)
    await assertPaid('S-03', order.orderId)
  })

  test('S-04 partial refunds of 10,00 zł then 5,00 zł are accepted, one over the rest is refused', async ({ page }) => {
    const order = await placeOrder()
    await openGateway(page, order.redirectUrl)
    await payBlik(page)
    await waitPaid(order.orderId)
    const [attempt] = await rows('payment_attempts', { order_id: order.orderId })
    const txn = attempt.dpay_transaction_id
    const ref = (grosze) => bridge('refund', { txn, grosze, messageId: `s04-${crypto.randomBytes(6).toString('hex')}` })

    const first = await ref(1000)
    const second = await ref(500)
    expect(first.outcome, first.message).toBe('accepted')
    expect(second.outcome, second.message).toBe('accepted')
    const over = await ref(total() - 1500 + 1) // one grosz more than is left
    expect(over.httpStatus).toBe(400)
    expect(over.outcome).toBe('rejected')

    const details = await bridge('details', { txn })
    // Sum every numeric/decimal field whose name mentions "refund": the parser does not read one yet (S-06 finds it).
    const refunded = []
    const walk = (v, key = '') => {
      if (v && typeof v === 'object') return Object.entries(v).forEach(([k, x]) => walk(x, k))
      if (/refund|zwrot/i.test(key) && (typeof v === 'string' || typeof v === 'number')) refunded.push([key, v])
    }
    walk(details.raw)
    record('S-04', 'details after two refunds: refund-looking fields', { found: refunded.map(([k]) => k), shape: shapeOf(details.raw) })
    expect.soft(refunded.length, 'details reports refunded sums (field names in the run log)').toBeGreaterThan(0)
    const sums = refunded.map(([, v]) => bridge('parse', { str: String(v) }).grosze ?? null)
    expect.soft(sums, 'a refund field equals 15,00 zł').toContain(1500)
  })

  test('S-05 poll path: the IPN URL is wrong, order-status confirms through details', async ({ page }) => {
    // Registers the transaction ourselves with an unreachable IPN URL; everything after is the real code.
    const email = `runner-sbx-poll-${rand()}@test.local`
    const runner = await h.stack.sessionFor(email)
    const { orderId, redirectUrl } = bridge('brokenIpnOrder', { event, email, price: PRICE })
    await openGateway(page, redirectUrl)
    await payBlik(page)

    // order-status only checks attempts older than 15 s, at most once per 10 s.
    const status = await waitFor(async () => {
      const r = await h.fx.callFn('order-status', runner, { orderId })
      return r.body?.data?.status === 'paid' ? r : null
    }, { what: 'order-status to confirm through details', every: 12_000 })
    expect(status.body.data.status).toBe('paid')
    const events = await rows('payment_events', { order_id: orderId })
    expect(events.some((e) => e.kind === 'ipn')).toBe(false)
    expect(events.some((e) => e.kind === 'status_check')).toBe(true)
  })

  test('S-06 records the real details/refund shapes and whether a repeated message id refunds twice', async ({ page }) => {
    const order = await placeOrder()
    await openGateway(page, order.redirectUrl)
    await payBlik(page)
    await waitPaid(order.orderId)
    const [attempt] = await rows('payment_attempts', { order_id: order.orderId })
    const txn = attempt.dpay_transaction_id

    const before = await bridge('details', { txn })
    record('S-06', 'details before a refund (values redacted)', { status: before.status, grosze: before.grosze, shape: shapeOf(before.raw) })

    const messageId = `s06-${crypto.randomBytes(6).toString('hex')}`
    const r1 = await bridge('refund', { txn, grosze: 500, messageId })
    record('S-06', 'refund response', { outcome: r1.outcome, httpStatus: r1.httpStatus, message: r1.message })
    expect(r1.outcome, r1.message).toBe('accepted')
    const mid = await bridge('details', { txn })
    record('S-06', 'details after a partial refund (values redacted)', { status: mid.status, grosze: mid.grosze, shape: shapeOf(mid.raw) })

    // Same DigitalPayments-PSP-Message-ID again. NOT an idempotency key per the docs; this proves it (or not).
    const r2 = await bridge('refund', { txn, grosze: 500, messageId })
    const after = await bridge('details', { txn })
    const refundFields = []
    const walk = (v, key = '') => {
      if (v && typeof v === 'object') return Object.entries(v).forEach(([k, x]) => walk(x, k))
      if (/refund|zwrot/i.test(key)) refundFields.push([key, v])
    }
    walk(after.raw)
    record('S-06', 'repeated message id', {
      secondOutcome: r2.outcome, secondHttpStatus: r2.httpStatus, secondMessage: r2.message,
      refundedTwice: r2.outcome === 'accepted', refundFieldsAfter: refundFields,
    })
    test.info().annotations.push({ type: 'S-06', description: `repeat of a message id -> ${r2.outcome} (${r2.httpStatus})` })
  })
})
