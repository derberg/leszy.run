import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import { clearMessages, messagesTo } from '../helpers/emailCapture.js'
import { dpayRefunds, dpayReset, dpayTransactions, payMock } from '../helpers/dpayControl.js'
import { DPAY_MOCK_PORT } from '../helpers/dpayMock.js'
import { one, orderOf, orderOk, person, rows, runnerEmail } from '../helpers/orders.js'

// Plan 6 task 7, O-60 in docs/registration/scenario-matrix.md: one refund seen by every audience.
// The runner pays 60 zł, the owner gives 20 back, an admin gives the other 40; the viewer's start
// list follows, the runner gets both e-mails, and a message to everybody no longer reaches them.

const ZT = '00000000-0000-4000-8000-0000000000c1'
const BIEG = { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 20 }
const PAY_PAGE = new RegExp(`localhost:${DPAY_MOCK_PORT}\\/pay\\/`)
// Whatever a charge to the runner would be called. Nothing like it may appear on their way.
const FEE = /Wspieram|Obsługa płatności|Wsparcie LESZY|prowizj|opłata serwisowa/i

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
  await page.goto(path)
  return page
}

async function latestTxn(orderId) {
  const { data } = await admin().from('payment_attempts').select('dpay_transaction_id')
    .eq('order_id', orderId).order('created_at', { ascending: false }).limit(1)
  return data[0].dpay_transaction_id
}

/** Somebody else on the same list, paid: the one a message to everybody still reaches. */
async function bystander(e) {
  const email = runnerEmail('obok')
  const out = await orderOk(e, { people: [person(email, { firstName: 'Anna', lastName: 'Wiśniewska' })] })
  const paid = await callFn('pay-order', await sessionFor(email), { orderId: out.orderId })
  expect(paid.status, JSON.stringify(paid.body)).toBe(200)
  await payMock(await latestTxn(out.orderId), 'paid')
  await expect.poll(async () => (await orderOf(out.orderId)).status, { timeout: 15_000 }).toBe('paid')
  return email
}

const zgloszenia = (eventId) => `/klub/zatyrani-test/wydarzenia/${eventId}/zgloszenia`
const header = (page) => page.getByTestId('start-list-header')
const entryOf = (page, name) => page.getByTestId('start-list-entry').filter({ hasText: name })
const statusOf = (page, name) => page.getByTestId('registrations').getByTestId('registration-row')
  .filter({ has: page.getByText(name, { exact: true }) }).getByTestId('registration-status')

async function refund(page, name, amount, button) {
  await page.getByRole('button', { name: `Akcje — ${name}` }).first().click()
  await page.getByRole('menuitem', { name: 'Zwróć wpłatę', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Zwróć wpłatę' })
  await dialog.getByLabel('Kwota zwrotu — Opłata startowa').fill(amount)
  await dialog.getByRole('button', { name: button, exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

const refundMails = async () => (await messagesTo(ACTOR_EMAILS.runner)).filter((m) => m.subject.startsWith('Zwrot'))

test('O-60 one refund across four audiences: the runner pays 60 zł, the owner gives back 20, an admin the rest; the list, the mail, the audit and a later message follow; no runner fee anywhere', async ({ actors }) => {
  await resetThrottle()
  await dpayReset()
  await clearMessages()
  const e = await createPublishedPaidEvent(owner, { competitions: [BIEG], prices: { 'Bieg 9 km': 6000 } })
  const { name: eventName } = await one('registration_settings', { event_id: e.eventId })
  const annaEmail = await bystander(e)

  // The runner pays 60 zł, and that is the whole charge.
  const runnerName = 'Ola Zwrotna'
  const order = await orderOk(e, { people: [person(ACTOR_EMAILS.runner, { firstName: 'Ola', lastName: 'Zwrotna' })] })
  const runner = await open(actors.runner, `/zamowienie/${order.orderId}`)
  await expect(runner.getByTestId('order-pending')).not.toContainText(FEE)
  await runner.getByTestId('order-pay').click()
  await expect(runner).toHaveURL(PAY_PAGE)
  await expect(runner.getByTestId('amount')).toHaveText('60.00')
  await payMock(await latestTxn(order.orderId), 'paid')
  await runner.goto(`/zamowienie/${order.orderId}`)
  await expect(runner.getByTestId('order-paid-label')).toHaveText(/Opłacone · 60,00 zł/i)
  await expect(runner.locator('#main-content')).not.toContainText(FEE)
  const paidOrder = await orderOf(order.orderId)
  expect([paidOrder.total, paidOrder.entry_total, paidOrder.extras_total, paidOrder.donation]).toEqual([6000, 6000, 0, 0])

  const [reg] = await rows('registrations', { order_id: order.orderId })
  const participant = () => one('participants', { id: reg.participant_id })

  // The viewer sees the runner on the list.
  const viewer = await open(actors.viewer, `/events/${e.slug}/lista`)
  await expect(header(viewer)).toHaveText('2 osoby zapisane')
  await expect(entryOf(viewer, runnerName)).toHaveCount(1)

  // The owner refunds 20 zł: the runner hears of it, the entry stands, the list does not change.
  const ownerPage = await open(actors.owner, zgloszenia(e.eventId))
  await refund(ownerPage, runnerName, '20', 'Zwróć 20,00 zł')
  await expect(statusOf(ownerPage, runnerName)).toHaveText('OPŁACONE · ZWROT 20 ZŁ')
  await expect.poll(async () => (await refundMails()).map((m) => m.subject))
    .toEqual([`Zwrot 20,00 zł — ${eventName}`])
  await viewer.reload()
  await expect(header(viewer)).toHaveText('2 osoby zapisane')
  await expect(entryOf(viewer, runnerName)).toHaveCount(1)
  expect((await participant()).removed_at).toBeNull()

  // An admin refunds the remaining 40 zł: the entry is cancelled and leaves the list.
  const adminPage = await open(actors.admin, zgloszenia(e.eventId))
  await refund(adminPage, runnerName, '40', 'Zwróć 40,00 zł i anuluj zgłoszenie')
  await expect(statusOf(adminPage, runnerName)).toHaveText('ANULOWANE')
  await expect.poll(async () => (await refundMails()).map((m) => m.subject))
    .toEqual([`Zwrot 20,00 zł — ${eventName}`, `Zwrot 40,00 zł — ${eventName}`])
  await viewer.reload()
  await expect(header(viewer)).toHaveText('1 osoba zapisana')
  await expect(entryOf(viewer, runnerName)).toHaveCount(0)
  await expect(viewer.getByTestId('start-list')).not.toContainText('Zwrotna')
  expect((await participant()).removed_at).not.toBeNull()

  // Every złoty came back, with nothing kept back: the two refunds are the whole payment.
  const txn = await latestTxn(order.orderId)
  expect((await dpayTransactions()).find((t) => t.id === txn).grosze).toBe(6000)
  expect((await dpayRefunds()).filter((r) => r.txnId === txn).map((r) => r.grosze)).toEqual([2000, 4000])
  for (const mail of await refundMails()) expect(mail.text).not.toMatch(FEE)

  // Four audit rows, a request and a settlement per refund, each under whoever did it.
  const profileOf = async (email) => (await one('profiles', { email })).id
  const { data: audit, error } = await admin().from('organizer_actions').select('action, actor_id, target')
    .eq('event_id', e.eventId).in('action', ['refund_requested', 'refund_settled'])
  expect(error).toBeNull()
  const refundIds = (await rows('refunds', { order_id: order.orderId })).map((r) => r.id)
  expect(audit.every((a) => refundIds.includes(a.target))).toBe(true)
  const [ownerId, adminId] = [await profileOf(ACTOR_EMAILS.owner), await profileOf(ACTOR_EMAILS.admin)]
  expect(audit.map((a) => `${a.action} ${a.actor_id}`).sort()).toEqual([
    `refund_requested ${adminId}`, `refund_requested ${ownerId}`, `refund_settled ${adminId}`, `refund_settled ${ownerId}`,
  ].sort())

  // The admin writes to „Wszyscy zgłoszeni”: the runner is out of the event, Anna is not.
  await adminPage.getByRole('button', { name: 'Wiadomość do uczestników' }).click()
  const dialog = adminPage.getByRole('dialog', { name: 'Wiadomość do uczestników' })
  await dialog.getByRole('button', { name: 'Wszyscy zgłoszeni' }).click()
  await expect(dialog.getByTestId('message-count')).toHaveText('DO 1 OSOBY')
  const subject = `Biuro zawodów ${Date.now()}`
  await dialog.getByLabel('Temat').fill(subject)
  await dialog.getByLabel('Treść').fill('Biuro zawodów od 8:00.')
  await dialog.getByRole('button', { name: 'Wyślij', exact: true }).click()
  await expect(adminPage.getByTestId('entries-notice')).toContainText('Wysłano do 1 osoby')
  await expect.poll(async () => (await messagesTo(annaEmail)).filter((m) => m.subject === subject)).toHaveLength(1)
  expect((await messagesTo(ACTOR_EMAILS.runner)).filter((m) => m.subject === subject)).toEqual([])
})
