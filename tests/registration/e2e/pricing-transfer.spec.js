import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedFreeEvent as createPublishedFreeEventFor, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import { clearMessages, lastCodeFor, messagesTo } from '../helpers/emailCapture.js'
import { dpayReset } from '../helpers/dpayControl.js'
import { DPAY_MOCK_PORT } from '../helpers/dpayMock.js'
import { makeExtra, setCharity, setTiers, warsawDay } from '../helpers/cart.js'
import { one, orderOf, rows, runnerEmail } from '../helpers/orders.js'
import { enableTransfers } from '../helpers/transfers.js'
import { assertVoucherInvariant } from '../helpers/voucherInvariant.js'
import { startScratchHost } from '../helpers/hostPull.js'

// Plan 7 task 10, V-80 (and V-81's e-mail half) in docs/registration/scenario-matrix.md: one
// partnered, discounted package seen by four audiences in parallel contexts, then handed on.
//   owner    creates partner „Sklep Biegacz” and code BIEGACZ15 (15 %, 10 uses, with that partner) in
//            Płatności, on a charity event with tiers 60 / 70 zł and a shirt;
//   runner   registers with the code, a shirt M and +10 zł, pays on the mock; RA4's line reads
//            „60,00 zł − 15% (BIEGACZ15) = 51,00 zł” and orders.total is cartAmounts' (no runner fee:
//            ruling T4-F, entry + extras + donation and nothing else);
//   owner    sees the row with the partner and the chip count 1; viewer's start list shows the runner
//            paid, with no partner text;
//   runner   invites invitee from RA6; invitee takes the package on RA7 with the e-mail code;
//   viewer   sees the invitee instead of the runner; the runner's e-mail names the invitee; the B3 row
//            keeps the partner and the code; the timing host pulls the old participant (removed_at)
//            and the new one; the code's `used` stays 1.

const ZT = '00000000-0000-4000-8000-0000000000c1'
const BIEG = { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }
const PAY_PAGE = new RegExp(`localhost:${DPAY_MOCK_PORT}\\/pay\\/`)
const TOKEN_RE = /\/przekazanie#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/
const PRICING = fileURLToPath(new URL('../../../supabase/functions/_shared/registration/pricing.js', import.meta.url))
// Whatever a charge to the runner would be called. Nothing like it may appear on their way (T4-F).
const FEE = /Wspieram|Obsługa płatności|Wsparcie LESZY|prowizj|opłata serwisowa/i
const PARTNER = 'Sklep Biegacz'
const CODE = 'BIEGACZ15'
const LINE = `60,00 zł − 15% (${CODE}) = 51,00 zł`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** cartAmounts (pricing.js), run in plain Node: Playwright's loader reads the shared module as CommonJS. */
function cartAmounts(cart) {
  const script = `const { cartAmounts } = await import(${JSON.stringify(PRICING)}); process.stdout.write(JSON.stringify(cartAmounts(${JSON.stringify(cart)})))`
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
}

let owner
test.beforeAll(async () => {
  owner = await sessionFor(ACTOR_EMAILS.owner)
  const status = await callFn('organizer-status', owner, { clubId: ZT })
  if (!status.body.data.agreementAccepted) {
    await callFn('accept-organizer-agreement', owner, { clubId: ZT, version: status.body.data.version })
  }
})

async function open(context, path) {
  const page = await context.newPage()
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  if (path) await page.goto(path)
  return page
}

async function waitForMail(email, re) {
  for (let i = 0; i < 60; i++) {
    const m = (await messagesTo(email)).find((x) => re.test(x.subject))
    if (m) return m
    await sleep(250)
  }
  throw new Error(`no e-mail ${re} to ${email}`)
}

async function codeFor(email) {
  for (let i = 0; i < 60; i++) {
    const code = await lastCodeFor(email)
    if (code) return code
    await sleep(250)
  }
  throw new Error(`no code e-mail for ${email}`)
}

const zgloszenia = (eventId) => `/klub/zatyrani-test/wydarzenia/${eventId}/zgloszenia`
const platnosci = (eventId) => `/klub/zatyrani-test/wydarzenia/${eventId}/platnosci`

test('V-80 a partnered, discounted package across four audiences: the partner made in Partnerzy and the code in Płatności, paid with a shirt and a donation, handed on through RA6/RA7; the list, the panel, the e-mails and the timing host follow; used stays 1', async ({ actors }) => {
  test.setTimeout(180_000)
  await resetThrottle()
  await dpayReset()
  await clearMessages()

  // A charity event: tiers 60 zł (ten more days) then 70 zł, a shirt, transfers allowed.
  const e = await createPublishedPaidEvent(owner, { competitions: [BIEG], prices: { 'Bieg 9 km': 6000 } })
  const [c9] = e.categoryIds
  await setTiers(e.eventId, [{ endsOn: warsawDay(10), prices: { [c9]: 6000 } }, { endsOn: null, prices: { [c9]: 7000 } }])
  await setCharity(e.eventId, true)
  await admin().from('registration_settings').update({ charity_goal: 'Rehabilitacja Zosi' }).eq('event_id', e.eventId)
  await makeExtra(e, { name: 'Koszulka', price: 4500, variants: [['S', 10], ['M', 10]] })
  await enableTransfers(e)
  const { name: eventName } = await one('registration_settings', { event_id: e.eventId })

  // ---- owner: the partner in Partnerzy, the code in Płatności.
  const org = await open(actors.owner, platnosci(e.eventId).replace(/platnosci$/, 'partnerzy'))
  const partners = org.getByTestId('partners')
  await partners.getByRole('button', { name: '+ Partner' }).click()
  const pd = org.getByRole('dialog', { name: 'Nowy partner' })
  await pd.getByLabel('Nazwa').fill(PARTNER)
  await pd.getByRole('button', { name: 'Dodaj partnera' }).click()
  await expect(pd).toHaveCount(0)
  await expect(partners.getByTestId('partner-row')).toHaveText([new RegExp(PARTNER)])
  await org.goto(platnosci(e.eventId))
  const codes = org.getByTestId('vouchers')
  await codes.getByRole('button', { name: '+ Kod' }).click()
  const cd = org.getByRole('dialog', { name: 'Nowy kod' })
  await cd.getByLabel('Kod · opcjonalnie').fill(CODE)
  await cd.getByLabel('Rabat (%)').fill('15')
  await cd.getByLabel('Limit użyć').fill('10')
  await cd.getByLabel('Partner').selectOption({ label: PARTNER })
  await cd.getByRole('button', { name: 'Dodaj kod' }).click()
  await expect(cd).toHaveCount(0)
  const codeRow = codes.getByTestId('voucher-row').filter({ hasText: CODE })
  await expect(codeRow).toContainText('−15%')
  await expect(codeRow).toContainText('0 / 10')
  await expect(codeRow).toContainText(PARTNER)
  const voucher = await one('vouchers', { event_id: e.eventId, code: CODE })
  const partner = await one('event_partners', { event_id: e.eventId, name: PARTNER })
  expect([voucher.percent, voucher.max_uses, voucher.used, voucher.partner_id]).toEqual([15, 10, 0, partner.id])

  // ---- runner: the code, a shirt M and +10 zł; RA4's line and total are cartAmounts'.
  const runner = await open(actors.runner, `/events/${e.slug}`)
  await runner.getByTestId('competition').filter({ hasText: 'Bieg 9 km' }).click()
  await runner.locator('#p-first').fill('Ola')
  await runner.locator('#p-last').fill('Przekazująca')
  await runner.locator('#p-birth').fill('1990-04-12')
  await runner.getByRole('button', { name: 'Kobieta', exact: true }).click()
  await runner.locator('#p-email').fill(ACTOR_EMAILS.runner)
  await runner.locator('#p-phone').fill('600100200')
  await runner.getByLabel('Kod rabatowy').fill(CODE.toLowerCase())
  await runner.getByRole('button', { name: 'Sprawdź' }).click()
  await expect(runner.getByTestId('voucher-ok')).toHaveText(LINE)
  const shirt = runner.getByTestId('extra').filter({ hasText: 'Koszulka' })
  await shirt.getByLabel('Wariant').selectOption({ label: 'M' })
  await shirt.getByLabel('Ilość').selectOption('1')
  const boxes = runner.getByTestId('consents').getByRole('checkbox')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
  // The session is the runner's own address: no e-mail code.
  await runner.getByTestId('registration-submit').click()
  await expect(runner.getByTestId('checkout')).toBeVisible()
  const line = runner.getByTestId('checkout-line')
  await expect(line.getByTestId('checkout-voucher')).toHaveText(LINE)
  await expect(line.getByTestId('checkout-line-price')).toHaveText('51,00 zł')
  await expect(line.getByTestId('checkout-extra')).toHaveText(['Koszulka · M · 45,00 zł'])
  await runner.getByRole('radio', { name: '+10 zł' }).click()
  const expected = cartAmounts({ people: [{ listPrice: 6000, voucherPercent: 15, extras: [{ price: 4500, qty: 1 }] }], donation: 1000 })
  expect([expected.entryTotal, expected.extrasTotal, expected.donation, expected.total]).toEqual([5100, 4500, 1000, 10600])
  await expect(runner.getByTestId('amount-entries')).toHaveText(/Opłaty startowe\s*51,00 zł/)
  await expect(runner.getByTestId('amount-extras')).toHaveText(/Dodatki\s*45,00 zł/)
  await expect(runner.getByTestId('amount-donation')).toHaveText(/Dodatkowa darowizna na cel\s*10,00 zł/)
  await expect(runner.getByTestId('checkout-total')).toHaveText(/Razem\s*106,00 zł/)
  await expect(runner.getByTestId('checkout')).not.toContainText(FEE)
  await runner.getByTestId('pay').click()
  await expect(runner).toHaveURL(PAY_PAGE)
  await expect(runner.getByTestId('amount')).toHaveText('106.00')
  await runner.getByRole('button', { name: 'Zapłać (mock)' }).click()
  await runner.waitForURL((u) => !PAY_PAGE.test(u.href)).catch(() => {})
  const orderOfRunner = async () => (await admin().from('orders').select('*').eq('event_id', e.eventId).eq('buyer_email', ACTOR_EMAILS.runner)).data[0]
  await expect.poll(async () => (await orderOfRunner())?.status, { timeout: 15_000 }).toBe('paid')
  const order = await orderOfRunner()
  // The mock's return URL is slot 0's site; the order page is opened here, as O-60 does.
  await runner.goto(`/zamowienie/${order.id}`)
  await expect(runner.getByTestId('order-paid-label')).toHaveText(/Opłacone · 106,00 zł/i)
  await expect(runner.locator('#main-content')).not.toContainText(FEE)
  expect([order.entry_total, order.extras_total, order.donation, order.total])
    .toEqual([expected.entryTotal, expected.extrasTotal, expected.donation, expected.total])
  const [reg] = await rows('registrations', { order_id: order.id })
  expect([reg.status, reg.list_price, reg.price, reg.voucher_id, reg.partner_id]).toEqual(['confirmed', 6000, 5100, voucher.id, partner.id])
  expect((await one('vouchers', { id: voucher.id })).used).toBe(1)

  // ---- owner: the row carries the partner, the chip counts 1. viewer: paid, no partner anywhere.
  const panel = await open(actors.owner, zgloszenia(e.eventId))
  const table = panel.getByTestId('registrations')
  const rowOf = (name) => table.getByTestId('registration-row').filter({ has: panel.getByText(name, { exact: true }) })
  await expect(rowOf('Ola Przekazująca').getByTestId('registration-partner')).toHaveText(PARTNER)
  await expect(rowOf('Ola Przekazująca').getByTestId('registration-status')).toHaveText('OPŁACONE')
  await expect(panel.getByTestId('partner-chips').getByRole('button', { name: new RegExp(`^${PARTNER}`) })).toHaveText(`${PARTNER} · 1`)

  const viewer = await open(actors.viewer, `/events/${e.slug}/lista`)
  const entries = viewer.getByTestId('start-list-entry')
  await expect(viewer.getByTestId('start-list-header')).toHaveText('1 osoba zapisana')
  await expect(entries.filter({ hasText: 'Ola Przekazująca' })).toHaveCount(1)
  await expect(viewer.locator('#main-content')).not.toContainText(PARTNER)
  await expect(viewer.locator('#main-content')).not.toContainText(CODE)

  // ---- runner: RA5 on the order page → RA6, the invite.
  const invitee = runnerEmail('invitee')
  await runner.getByRole('link', { name: 'Przekaż pakiet innej osobie →' }).click()
  await expect(runner).toHaveURL(new RegExp(`/events/${e.slug}/przekaz/${reg.id}$`))
  await runner.getByLabel('E-mail osoby, która przejmie pakiet').fill(invitee)
  await runner.getByRole('button', { name: 'Wyślij zaproszenie' }).click()
  await expect(runner.getByTestId('transfer-pending')).toContainText(`Czeka na ${invitee}`)
  const token = (await waitForMail(invitee, /przekazuje Ci start/)).text.match(TOKEN_RE)[1]

  // ---- invitee: RA7 with the e-mail code.
  const ra7 = await open(actors.invitee, `/przekazanie#${token}`)
  const form = ra7.getByTestId('transfer-accept')
  await expect(form).toBeVisible()
  await expect(form).toContainText('Ola')
  await expect(form).not.toContainText('Przekazująca')
  await expect(form).not.toContainText(PARTNER)
  await expect(form).not.toContainText(CODE)
  await ra7.locator('#p-first').fill('Jan')
  await ra7.locator('#p-last').fill('Nowak')
  await ra7.locator('#p-birth').fill('1988-03-04')
  await ra7.getByRole('button', { name: 'Mężczyzna' }).click()
  await ra7.locator('#p-email').fill(invitee)
  await ra7.locator('#p-phone').fill('+48600111222')
  const consents = ra7.getByTestId('consents').getByRole('checkbox')
  for (let i = 0; i < await consents.count(); i++) await consents.nth(i).check()
  await ra7.getByRole('button', { name: 'Przyjmij pakiet' }).click()
  await ra7.locator('#reg-code').fill(await codeFor(invitee))
  await ra7.getByRole('button', { name: 'Przyjmij pakiet' }).click()
  await expect(ra7.getByTestId('transfer-done')).toBeVisible()

  const [moved] = (await admin().from('registrations').select('*').eq('event_id', e.eventId).eq('email', invitee)).data
  expect([moved.status, moved.order_id, moved.price, moved.voucher_id, moved.partner_id]).toEqual(['confirmed', order.id, 5100, voucher.id, partner.id])
  expect((await one('registrations', { id: reg.id })).status).toBe('transferred_out')

  // ---- viewer: the invitee instead of the runner, still paid, still no partner.
  await expect(async () => {
    await viewer.reload()
    await expect(entries).toHaveText([/Jan Nowak/], { timeout: 3000 })
  }).toPass({ timeout: 20_000 })
  await expect(viewer.getByTestId('start-list-header')).toHaveText('1 osoba zapisana')
  await expect(entries.filter({ hasText: 'Jan Nowak' })).toHaveCount(1)
  await expect(viewer.getByTestId('start-list')).not.toContainText('Przekazująca')
  await expect(viewer.locator('#main-content')).not.toContainText(PARTNER)

  // ---- the runner's e-mail names the invitee (first name and surname, never the address).
  const taken = await waitForMail(ACTOR_EMAILS.runner, /^Pakiet przejęła/)
  expect(taken.subject).toBe(`Pakiet przejęła Jan Nowak — ${eventName}`)
  expect(taken.text).toContain('Jan Nowak przejmuje Twój pakiet')
  expect(taken.text).not.toContain(invitee)
  await waitForMail(invitee, /^Jesteś na liście/)

  // ---- owner: the B3 row of the new holder keeps the partner and the code; the chip still counts 1.
  await panel.reload()
  await expect(rowOf('Jan Nowak').getByTestId('registration-partner')).toHaveText(PARTNER)
  await expect(rowOf('Jan Nowak').getByTestId('registration-status')).toHaveText('OPŁACONE')
  await expect(panel.getByTestId('partner-chips').getByRole('button', { name: new RegExp(`^${PARTNER}`) })).toHaveText(`${PARTNER} · 1`)
  const list = await callFn('list-event-registrations', owner, { eventId: e.eventId })
  expect(list.status, JSON.stringify(list.body)).toBe(200)
  const b3 = list.body.data.find((x) => x.id === moved.id)
  expect([b3.partnerName, b3.voucherCode]).toEqual([PARTNER, CODE])

  // ---- V-81: neither the runner's nor the invitee's mail names the partner (or its id).
  const mails = [...await messagesTo(ACTOR_EMAILS.runner), ...await messagesTo(invitee)]
  expect(mails.length).toBeGreaterThanOrEqual(4)
  for (const m of mails) {
    const all = `${m.subject}\n${m.text}\n${m.html ?? ''}`
    expect(all, m.subject).not.toContain(PARTNER)
    expect(all, m.subject).not.toContain(partner.id)
    expect(all, m.subject).not.toMatch(FEE)
  }

  // ---- the timing host: the old participant with removed_at, the new one without.
  const host = await startScratchHost()
  try {
    const { errors } = await host.pull()
    expect(errors).toEqual([])
    const pulled = (await host.sql`select id, first_name, last_name, removed_at from participants where event_id = ${e.eventId} order by first_name`)
      .map((p) => ({ id: p.id, name: `${p.first_name} ${p.last_name}`, removed: p.removed_at !== null }))
    expect(pulled).toEqual([
      { id: moved.participant_id, name: 'Jan Nowak', removed: false },
      { id: reg.participant_id, name: 'Ola Przekazująca', removed: true },
    ])
  } finally {
    await host.stop()
  }

  // ---- the code was used once, by the package, wherever it sits.
  expect((await one('vouchers', { id: voucher.id })).used).toBe(1)
  await assertVoucherInvariant(voucher.id)
  expect((await orderOf(order.id)).total).toBe(expected.total)
})

// Final review I-1 + I-4 (V-90), with PAID_REGISTRATION_ENABLED true: Plan 7's money features are live
// for everyone. Every request of this page carries x-registration-money: off, which only mattered while the
// flag was false, so the page must still show them; a runner who adds nothing still registers free.
test('V-90 flag on: a published free charity event with donations and a shirt shows the extra and the donation chips despite the off header; an empty cart registers free', async ({ actors }) => {
  await resetThrottle()
  await clearMessages()
  const e = await createPublishedFreeEventFor(owner)
  await setCharity(e.eventId, true)
  await admin().from('registration_settings').update({ charity_goal: 'Rehabilitacja Zosi' }).eq('event_id', e.eventId)
  await makeExtra(e, { name: 'Koszulka', price: 4500, variants: [['M', 10]] })
  const email = runnerEmail('on')

  const page = await actors.viewer.newPage()
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  await page.route(/\/(api\/event|edge\/)/, (route) => route.continue({ headers: { ...route.request().headers(), 'x-registration-money': 'off' } }))
  await page.goto(`/events/${e.slug}`)
  const nine = page.getByTestId('competition').filter({ hasText: 'Bieg 9 km' })
  await expect(nine).toBeVisible()
  await expect(page.getByTestId('competition-extra').first()).toBeVisible()
  await nine.click()
  await page.locator('#p-first').fill('Ola')
  await page.locator('#p-last').fill('Bezpłatna')
  await page.locator('#p-birth').fill('1990-04-12')
  await page.getByRole('button', { name: 'Kobieta', exact: true }).click()
  await page.locator('#p-email').fill(email)
  await page.locator('#p-phone').fill('600100200')
  await expect(page.getByTestId('extra').first()).toBeVisible()
  // No code field: every entry here is 0 zł, so a code could not lower anything (the field needs a price).
  await expect(page.getByLabel('Kod rabatowy')).toHaveCount(0)
  const boxes = page.getByTestId('consents').getByRole('checkbox')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
  await page.getByTestId('registration-submit').click()
  await expect(page.getByTestId('code-step')).toBeVisible()
  await page.getByLabel('Kod (6 cyfr)').fill(await codeFor(email))
  // Donations are live, so the form goes on to the checkout with the chips; a 0 zł cart registers free.
  await page.getByRole('button', { name: 'Dalej' }).click()
  await expect(page.getByTestId('checkout')).toBeVisible()
  await expect(page.getByTestId('donation')).toContainText('Dodatkowa darowizna na cel: Rehabilitacja Zosi')
  await expect(page.getByRole('radio', { name: '0', exact: true })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('button', { name: 'Zapisz się' }).click()
  await expect(page).toHaveURL(new RegExp(`/events/${e.slug}/zapisano`))
  expect((await admin().from('orders').select('id').eq('event_id', e.eventId)).data).toEqual([])
  const [reg] = (await admin().from('registrations').select('status, price').eq('event_id', e.eventId)).data
  expect(reg).toEqual({ status: 'confirmed', price: 0 })
})
