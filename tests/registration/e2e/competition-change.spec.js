import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import { clearMessages, messagesTo } from '../helpers/emailCapture.js'
import { dpayRefunds, dpayReset, payMock } from '../helpers/dpayControl.js'
import { DPAY_MOCK_PORT } from '../helpers/dpayMock.js'
import { one, orderOf, orderOk, person, rows, runnerEmail } from '../helpers/orders.js'

// Competition change, task 9 (CC-90…CC-92 in docs/registration/scenario-matrix.md): the club moves an
// entry from B3's ⋯ „Zmień konkurencję”. Dearer: a surcharge the payer pays on /zamowienie/<id>, the
// entry moves on payment. Cheaper: the difference goes back through dpay at once. An open surcharge
// is reminded and cancelled from the same menu.

const ZT = '00000000-0000-4000-8000-0000000000c1'
const COMPETITIONS = [
  { name: 'Bieg 5 km', discipline: 'run', distanceLabel: '5 km', startTime: '10:00', capacity: 50 },
  { name: 'Bieg 10 km', discipline: 'run', distanceLabel: '10 km', startTime: '11:00', capacity: 50 },
]
const PRICES = { 'Bieg 5 km': 4000, 'Bieg 10 km': 6000 }
// CC-90's event also has a cheaper and a children's competition, so the dialog shows all three kinds of target.
const WIDE = [
  ...COMPETITIONS,
  { name: 'Marsz Nordic Walking 5 km', discipline: 'nw', distanceLabel: '5 km', startTime: '10:30', capacity: 50 },
  { name: 'Bieg Młodzików 2 km', discipline: 'run', distanceLabel: '2 km', startTime: '09:30', capacity: 50 },
]
const WIDE_PRICES = { ...PRICES, 'Marsz Nordic Walking 5 km': 3000, 'Bieg Młodzików 2 km': 2000 }
const PAY_PAGE = new RegExp(`localhost:${DPAY_MOCK_PORT}\\/pay\\/`)
const SCREENS = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../.superpowers/sdd/2026-11-24-competition-change/screens')

let owner

test.beforeAll(async () => {
  owner = await sessionFor(ACTOR_EMAILS.owner)
  const status = await callFn('organizer-status', owner, { clubId: ZT })
  if (!status.body.data.agreementAccepted) {
    await callFn('accept-organizer-agreement', owner, { clubId: ZT, version: status.body.data.version })
  }
})

async function open(context, p) {
  const page = await context.newPage()
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  await page.goto(p)
  // The cookie banner would cover the screenshots' lower half.
  await page.getByRole('button', { name: 'Odrzuć', exact: true }).click({ timeout: 3000 }).catch(() => {})
  return page
}

async function shot(page, name) {
  if (!fs.existsSync(path.dirname(SCREENS))) return
  fs.mkdirSync(SCREENS, { recursive: true })
  await page.screenshot({ path: path.join(SCREENS, name), fullPage: false })
}

async function latestTxn(orderId) {
  const { data } = await admin().from('payment_attempts').select('dpay_transaction_id')
    .eq('order_id', orderId).order('created_at', { ascending: false }).limit(1)
  return data[0].dpay_transaction_id
}

/** A paid entry of `email` in `competition`, paid through pay-order and the dpay mock. */
async function paidEntry(e, email, competition, name, list = COMPETITIONS) {
  const categoryId = e.categoryIds[list.findIndex((c) => c.name === competition)]
  const out = await orderOk(e, { categoryId, people: [person(email, name)] })
  const paid = await callFn('pay-order', await sessionFor(email), { orderId: out.orderId })
  expect(paid.status, JSON.stringify(paid.body)).toBe(200)
  await payMock(await latestTxn(out.orderId), 'paid')
  await expect.poll(async () => (await orderOf(out.orderId)).status, { timeout: 15_000 }).toBe('paid')
  const [reg] = await rows('registrations', { order_id: out.orderId })
  return { orderId: out.orderId, registrationId: reg.id }
}

const zgloszenia = (eventId) => `/klub/zatyrani-test/wydarzenia/${eventId}/zgloszenia`
const rowOf = (page, name) => page.getByTestId('registrations').getByTestId('registration-row')
  .filter({ has: page.getByText(name, { exact: true }) })
const surchargeOrderOf = async (registrationId) => {
  const { data } = await admin().from('orders').select('id, status, total')
    .eq('kind', 'surcharge').eq('surcharge_registration_id', registrationId).order('created_at', { ascending: false }).limit(1)
  return data[0] ?? null
}

/** The page scrolled to the top of the Zgłoszenia section, its tiles in full under the fixed navbar. */
async function toSectionTop(page) {
  await page.getByTestId('entries-actions').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 72))
}

async function openMenuItem(page, name, item) {
  await page.getByRole('button', { name: `Akcje — ${name}` }).first().click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

test('CC-90 dearer: the club moves Katarzyna from 5 km to 10 km, the payer pays the 20 zł surcharge on the order page, B3 shows 10 km', async ({ actors }) => {
  await resetThrottle()
  await dpayReset()
  await clearMessages()
  const e = await createPublishedPaidEvent(owner, { competitions: WIDE, prices: WIDE_PRICES })
  const { error: ageErr } = await admin().from('competitions').update({ max_age: 15 }).eq('category_id', e.categoryIds[3])
  if (ageErr) throw ageErr
  const { name: eventName } = await one('registration_settings', { event_id: e.eventId })
  await paidEntry(e, runnerEmail('obok'), 'Bieg 10 km', { firstName: 'Anna', lastName: 'Wiśniewska' }, WIDE)
  const runnerName = 'Katarzyna Zielińska'
  const entry = await paidEntry(e, ACTOR_EMAILS.runner, 'Bieg 5 km', { firstName: 'Katarzyna', lastName: 'Zielińska' }, WIDE)

  const ownerPage = await open(actors.owner, zgloszenia(e.eventId))
  await ownerPage.setViewportSize({ width: 1280, height: 800 })
  await rowOf(ownerPage, runnerName).waitFor()
  await ownerPage.getByRole('button', { name: `Akcje — ${runnerName}` }).first().click()
  await expect(ownerPage.getByRole('menuitem', { name: 'Zmień konkurencję', exact: true })).toBeVisible()
  await toSectionTop(ownerPage)
  await shot(ownerPage, 'po-b3-menu-desktop.png')
  await ownerPage.getByRole('menuitem', { name: 'Zmień konkurencję', exact: true }).click()

  const dialog = ownerPage.getByRole('dialog', { name: 'Zmień konkurencję' })
  const target = dialog.getByTestId('change-target').filter({ hasText: 'Bieg 10 km' })
  await expect(target).toContainText('60,00 zł · dopłata 20,00 zł — zapłata online')
  await expect(dialog.getByTestId('change-target').filter({ hasText: 'Marsz Nordic Walking 5 km' }))
    .toContainText('30,00 zł · zwrot 10,00 zł')
  const kids = dialog.getByTestId('change-target').filter({ hasText: 'Bieg Młodzików 2 km' })
  await expect(kids).toContainText('nie spełnia warunków')
  await expect(kids.getByRole('radio')).toBeDisabled()
  await target.getByRole('radio').check()
  await toSectionTop(ownerPage)
  await shot(ownerPage, 'po-dialog-desktop.png')
  await ownerPage.setViewportSize({ width: 390, height: 844 })
  const submit = dialog.getByRole('button', { name: 'Zmień konkurencję', exact: true })
  const box = await submit.boundingBox()
  expect(box.height).toBeLessThan(40) // one line at 390 px
  await shot(ownerPage, 'po-dialog-390.png')
  await ownerPage.setViewportSize({ width: 1280, height: 800 })
  await submit.click()
  await expect(dialog).toHaveCount(0)
  await expect(ownerPage.getByTestId('entries-notice')).toContainText('czeka na dopłatę 20,00 zł')

  // The row waits for the surcharge, with its reminder and cancel in place of the change.
  const badge = rowOf(ownerPage, runnerName).getByTestId('registration-surcharge')
  await expect(badge).toHaveText('Zmiana na Bieg 10 km — czeka na dopłatę 20,00 zł')
  await expect(rowOf(ownerPage, runnerName)).toContainText('Bieg 5 km')
  await toSectionTop(ownerPage)
  await shot(ownerPage, 'po-b3-badge-desktop.png')
  await ownerPage.setViewportSize({ width: 390, height: 844 })
  const cardBadge = ownerPage.getByTestId('registrations-cards').getByTestId('registration-surcharge')
  await expect(cardBadge).toHaveText('Zmiana na Bieg 10 km — czeka na dopłatę 20,00 zł')
  await cardBadge.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await shot(ownerPage, 'po-b3-badge-390.png')
  await ownerPage.setViewportSize({ width: 1280, height: 800 })

  // The payer gets the surcharge e-mail with the order's address.
  const surcharge = await surchargeOrderOf(entry.registrationId)
  expect([surcharge.status, surcharge.total]).toEqual(['pending', 2000])
  await expect.poll(async () => (await messagesTo(ACTOR_EMAILS.runner)).map((m) => m.subject))
    .toContain(`Dopłata za zmianę konkurencji — ${eventName}`)
  const mail = (await messagesTo(ACTOR_EMAILS.runner)).find((m) => m.subject.startsWith('Dopłata za zmianę'))
  expect(mail.text).toContain(`/zamowienie/${surcharge.id}`)

  const runner = await open(actors.runner, `/zamowienie/${surcharge.id}`)
  await runner.setViewportSize({ width: 1280, height: 800 })
  await expect(runner.getByTestId('order-surcharge-change')).toHaveText('Dopłata: zmiana z Bieg 5 km na Bieg 10 km')
  await expect(runner.getByTestId('order-surcharge-pending')).toContainText('Czeka na dopłatę · 20,00 zł')
  await expect(runner.getByTestId('order-deadline')).toBeVisible()
  await expect(runner.getByTestId('order-person')).toHaveCount(0)
  await shot(runner, 'po-order-surcharge-desktop.png')
  await runner.setViewportSize({ width: 390, height: 844 })
  await shot(runner, 'po-order-surcharge-390.png')
  await runner.getByTestId('order-pay').click()
  await expect(runner).toHaveURL(PAY_PAGE)
  await expect(runner.getByTestId('amount')).toHaveText('20.00')
  await payMock(await latestTxn(surcharge.id), 'paid')
  await runner.goto(`/zamowienie/${surcharge.id}`)
  await expect(runner.getByTestId('order-surcharge-paid')).toContainText('Opłacone · 20,00 zł')
  await expect(runner.getByTestId('order-surcharge-paid')).toContainText('Konkurencja zmieniona')

  await ownerPage.reload()
  await expect(rowOf(ownerPage, runnerName)).toContainText('Bieg 10 km')
  await expect(rowOf(ownerPage, runnerName).getByTestId('registration-surcharge')).toHaveCount(0)
  await expect(rowOf(ownerPage, runnerName).getByTestId('registration-payment')).toHaveText('60,00 zł')
})

test('CC-91 cheaper: the club moves Tomasz from 10 km to 5 km and the 20 zł difference is refunded at once', async ({ actors }) => {
  await resetThrottle()
  await dpayReset()
  await clearMessages()
  const e = await createPublishedPaidEvent(owner, { competitions: COMPETITIONS, prices: PRICES })
  const email = runnerEmail('tanszy')
  const name = 'Tomasz Kowalczyk'
  const entry = await paidEntry(e, email, 'Bieg 10 km', { firstName: 'Tomasz', lastName: 'Kowalczyk' })

  const ownerPage = await open(actors.owner, zgloszenia(e.eventId))
  await openMenuItem(ownerPage, name, 'Zmień konkurencję')
  const dialog = ownerPage.getByRole('dialog', { name: 'Zmień konkurencję' })
  const target = dialog.getByTestId('change-target').filter({ hasText: 'Bieg 5 km' })
  await expect(target).toContainText('40,00 zł · zwrot 20,00 zł')
  await target.getByRole('radio').check()
  await dialog.getByRole('button', { name: 'Zmień konkurencję', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(ownerPage.getByTestId('entries-notice')).toHaveText(`Zmieniono konkurencję: ${name} → Bieg 5 km. Zwrócono 20,00 zł.`)
  await expect(rowOf(ownerPage, name)).toContainText('Bieg 5 km')

  const txn = await latestTxn(entry.orderId)
  expect((await dpayRefunds()).filter((r) => r.txnId === txn).map((r) => r.grosze)).toEqual([2000])
  const reg = await one('registrations', { id: entry.registrationId })
  expect([reg.status, reg.price - reg.refunded]).toEqual(['confirmed', 4000])
})

test('CC-92 an open surcharge is reminded and then cancelled from the ⋯ menu; the entry stays in 5 km', async ({ actors }) => {
  await resetThrottle()
  await dpayReset()
  await clearMessages()
  const e = await createPublishedPaidEvent(owner, { competitions: COMPETITIONS, prices: PRICES })
  const email = runnerEmail('doplata')
  const name = 'Magdalena Wójcik'
  const entry = await paidEntry(e, email, 'Bieg 5 km', { firstName: 'Magdalena', lastName: 'Wójcik' })
  const tenKm = e.categoryIds[1]
  const made = await callFn('organizer-entry-action', owner, {
    action: 'change_competition', registrationId: entry.registrationId, categoryId: tenKm, expectedDifference: 2000,
    requestKey: crypto.randomUUID(),
  })
  expect(made.status, JSON.stringify(made.body)).toBe(200)
  const surchargeMails = async () => (await messagesTo(email)).filter((m) => /dopłata za zmianę konkurencji/i.test(m.subject))
  await expect.poll(async () => (await surchargeMails()).length).toBe(1)

  const ownerPage = await open(actors.owner, zgloszenia(e.eventId))
  await ownerPage.getByRole('button', { name: `Akcje — ${name}` }).first().click()
  await expect(ownerPage.getByRole('menuitem', { name: 'Zmień konkurencję', exact: true })).toHaveCount(0)
  await ownerPage.getByRole('menuitem', { name: 'Przypomnij o dopłacie', exact: true }).click()
  await expect(ownerPage.getByTestId('entries-notice')).toHaveText(`Przypomnienie wysłane — ${name}.`)
  await expect.poll(async () => (await surchargeMails()).map((m) => m.subject.startsWith('Przypomnienie'))).toEqual([false, true])

  await openMenuItem(ownerPage, name, 'Anuluj dopłatę')
  const confirm = ownerPage.getByRole('dialog', { name: 'Anulować dopłatę?' })
  await confirm.getByRole('button', { name: 'Anuluj dopłatę', exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect(ownerPage.getByTestId('entries-notice')).toContainText('Anulowano dopłatę')
  await expect(rowOf(ownerPage, name).getByTestId('registration-surcharge')).toHaveCount(0)
  await expect(rowOf(ownerPage, name)).toContainText('Bieg 5 km')
  expect((await surchargeOrderOf(entry.registrationId)).status).toBe('cancelled')
  await ownerPage.getByRole('button', { name: `Akcje — ${name}` }).first().click()
  await expect(ownerPage.getByRole('menuitem', { name: 'Zmień konkurencję', exact: true })).toBeVisible()
})
