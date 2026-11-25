import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import { dpayReset, payMock } from '../helpers/dpayControl.js'
import { DPAY_MOCK_PORT } from '../helpers/dpayMock.js'
import { enableTransfers } from '../helpers/transfers.js'
import { one, orderOf, orderOk, person, rows, runnerEmail, setSettings } from '../helpers/orders.js'

// Runner self-service, task 14 (RS-17 in docs/registration/scenario-matrix.md): on „Moje zapisy”
// (/profil/zapisy) the runner changes their own competition to a dearer one and pays the surcharge
// on the dpay mock, fixes their birth date, and sees neither button once the club unticks both
// switches.

const ZT = '00000000-0000-4000-8000-0000000000c1'
const COMPETITIONS = [
  { name: 'Bieg 5 km', discipline: 'run', distanceLabel: '5 km', startTime: '10:00', capacity: 50 },
  { name: 'Bieg 10 km', discipline: 'run', distanceLabel: '10 km', startTime: '11:00', capacity: 50 },
]
const PRICES = { 'Bieg 5 km': 4000, 'Bieg 10 km': 6000 }
const PAY_PAGE = new RegExp(`localhost:${DPAY_MOCK_PORT}\\/pay\\/`)
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }
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

async function shot(page, name) {
  if (!fs.existsSync(path.dirname(SCREENS))) return
  fs.mkdirSync(SCREENS, { recursive: true })
  await page.screenshot({ path: path.join(SCREENS, name), fullPage: false })
}

async function runnerPage(browser, email) {
  const session = await sessionFor(email)
  await admin().from('profiles').update({ username: `rs${crypto.randomBytes(4).toString('hex')}` }).eq('id', session.profileId)
  const context = await browser.newContext({ viewport: DESKTOP })
  await context.addCookies([{
    name: 'leszy_session', value: session.token, domain: 'localhost', path: '/',
    httpOnly: true, secure: false, sameSite: 'Lax',
  }])
  const page = await context.newPage()
  return { context, page, session }
}

async function latestTxn(orderId) {
  const { data } = await admin().from('payment_attempts').select('dpay_transaction_id')
    .eq('order_id', orderId).order('created_at', { ascending: false }).limit(1)
  return data[0].dpay_transaction_id
}

/** The runner's own entry in 5 km, paid through pay-order and the dpay mock. */
async function paidEntry(e, email, name) {
  const out = await orderOk(e, { categoryId: e.categoryIds[0], people: [person(email, name)] })
  const paid = await callFn('pay-order', await sessionFor(email), { orderId: out.orderId })
  expect(paid.status, JSON.stringify(paid.body)).toBe(200)
  await payMock(await latestTxn(out.orderId), 'paid')
  await expect.poll(async () => (await orderOf(out.orderId)).status, { timeout: 15_000 }).toBe('paid')
  const [reg] = await rows('registrations', { order_id: out.orderId })
  return { orderId: out.orderId, registrationId: reg.id }
}

async function toZapisy(page) {
  await page.goto('/profil/zapisy')
  // The cookie banner would cover the screenshots' lower half.
  await page.getByRole('button', { name: 'Odrzuć', exact: true }).click({ timeout: 3000 }).catch(() => {})
}

const personRow = (page, name) => page.getByTestId('zapisy-person').filter({ hasText: name })

async function noOverflow(page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(wide, 'no horizontal scroll at 390 px').toBe(false)
}

test('RS-17 the runner moves to a dearer competition and pays the surcharge; the entry shows 10 km', async ({ browser }) => {
  await resetThrottle()
  await dpayReset()
  const e = await createPublishedPaidEvent(owner, { name: `Bieg Samodzielny ${crypto.randomBytes(3).toString('hex')}`, competitions: COMPETITIONS, prices: PRICES })
  const email = runnerEmail('samo')
  const name = 'Joanna Biegaczka'
  const entry = await paidEntry(e, email, { firstName: 'Joanna', lastName: 'Biegaczka' })
  const { context, page } = await runnerPage(browser, email)

  await toZapisy(page)
  const row = personRow(page, name)
  await expect(row.getByTestId('zapisy-competition')).toHaveText(' · Bieg 5 km')
  await expect(row.getByRole('button', { name: `Zmień konkurencję — ${name}` })).toBeVisible()
  await expect(row.getByRole('button', { name: `Popraw dane — ${name}` })).toBeVisible()
  await shot(page, 'po-zapisy-actions-desktop.png')
  await page.setViewportSize(PHONE)
  for (const b of await row.getByTestId('self-service').getByRole('button').all()) {
    expect((await b.boundingBox()).height, 'a button label stays on one line').toBeLessThan(24)
  }
  await noOverflow(page)
  await shot(page, 'po-zapisy-actions-390.png')

  await row.getByTestId('self-change').click()
  const dialog = page.getByRole('dialog', { name: 'Zmień konkurencję' })
  const target = dialog.getByTestId('change-target').filter({ hasText: 'Bieg 10 km' })
  await expect(target).toContainText('60,00 zł · dopłata 20,00 zł — zapłata online')
  await target.getByRole('radio').check()
  const submit = dialog.getByRole('button', { name: 'Zmień i zapłać', exact: true })
  expect((await submit.boundingBox()).height).toBeLessThan(40)
  await noOverflow(page)
  await shot(page, 'po-runner-change-dialog-390.png')
  await submit.click()
  await expect(page).toHaveURL(/\/zamowienie\/[0-9a-f-]{36}$/)
  const surchargeId = page.url().split('/').pop()
  const surcharge = await orderOf(surchargeId)
  expect([surcharge.kind, surcharge.status, surcharge.total, surcharge.surcharge_registration_id])
    .toEqual(['surcharge', 'pending', 2000, entry.registrationId])

  // Back on the list the surcharge waits with its „Zapłać”, and no second change is offered.
  await toZapisy(page)
  const waiting = personRow(page, name).getByTestId('self-surcharge')
  await expect(waiting).toHaveText('Dopłata czeka: 20,00 zł (Bieg 10 km) — Zapłać')
  await expect(personRow(page, name).getByTestId('self-change')).toHaveCount(0)
  await noOverflow(page)
  await shot(page, 'po-zapisy-surcharge-390.png')
  await waiting.getByRole('link', { name: 'Zapłać' }).click()
  await expect(page).toHaveURL(new RegExp(`/zamowienie/${surchargeId}$`))
  await page.getByTestId('order-pay').click()
  await expect(page).toHaveURL(PAY_PAGE)
  await payMock(await latestTxn(surchargeId), 'paid')
  await expect.poll(async () => (await orderOf(surchargeId)).status, { timeout: 15_000 }).toBe('paid')

  await toZapisy(page)
  await expect(personRow(page, name).getByTestId('zapisy-competition')).toHaveText(' · Bieg 10 km')
  await expect(personRow(page, name).getByTestId('self-surcharge')).toHaveCount(0)
  expect((await one('registrations', { id: entry.registrationId })).category_id).toBe(e.categoryIds[1])
  await context.close()
})

test('RS-17 the runner fixes their birth date with „Popraw dane”; the names are not offered', async ({ browser }) => {
  await resetThrottle()
  await dpayReset()
  const e = await createPublishedPaidEvent(owner, { competitions: COMPETITIONS, prices: PRICES })
  const email = runnerEmail('data')
  const name = 'Marek Poprawny'
  const entry = await paidEntry(e, email, { firstName: 'Marek', lastName: 'Poprawny', gender: 'M' })
  const { context, page } = await runnerPage(browser, email)
  await page.setViewportSize(PHONE)

  await toZapisy(page)
  await personRow(page, name).getByTestId('self-edit').click()
  const dialog = page.getByRole('dialog', { name: 'Popraw dane' })
  const birth = dialog.getByLabel('Data urodzenia')
  await expect(birth).toHaveValue((await one('registrations', { id: entry.registrationId })).birth_date)
  await expect(dialog.getByLabel('Imię', { exact: true })).toHaveCount(0)
  await expect(dialog.getByLabel('Nazwisko')).toHaveCount(0)
  await birth.fill('1988-07-14')
  await noOverflow(page)
  await shot(page, 'po-runner-edit-dialog-390.png')
  await dialog.getByRole('button', { name: 'Zapisz', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(personRow(page, name).getByTestId('self-notice')).toHaveText(`Zapisano zmiany — ${name}.`)
  expect((await one('registrations', { id: entry.registrationId })).birth_date).toBe('1988-07-14')
  await context.close()
})

test('RS-17 the club unticks both switches: neither button is shown', async ({ browser }) => {
  await resetThrottle()
  await dpayReset()
  const e = await createPublishedPaidEvent(owner, { competitions: COMPETITIONS, prices: PRICES })
  const email = runnerEmail('wyl')
  const name = 'Ewa Zablokowana'
  await paidEntry(e, email, { firstName: 'Ewa', lastName: 'Zablokowana' })
  const { context, page } = await runnerPage(browser, email)

  await toZapisy(page)
  await expect(personRow(page, name).getByTestId('self-change')).toBeVisible()
  await setSettings(e.eventId, { runner_competition_change: false, runner_data_edit: false })
  await toZapisy(page)
  await expect(personRow(page, name)).toBeVisible()
  await expect(personRow(page, name).getByTestId('self-service')).toHaveCount(0)
  await context.close()
})

// Review screenshots only (written when the review directory exists): where the runner finds the actions.
// The red outline is injected here and never ships in the app.
const OUTLINE = '{ outline: 3px solid #e00 !important; outline-offset: 3px; }'
async function outlined(page, testIds) {
  await page.addStyleTag({ content: testIds.map((t) => `[data-testid="${t}"] ${OUTLINE}`).join('\n') })
}

test('RS-18 where the runner finds Zmień konkurencję, Popraw dane and Przekaż pakiet (screenshots)', async ({ browser }) => {
  await resetThrottle()
  const e = await createPublishedPaidEvent(owner, { name: `Bieg Leśny ${crypto.randomBytes(3).toString('hex')}`, competitions: COMPETITIONS, prices: PRICES })
  await enableTransfers(e)
  const email = runnerEmail('gdzie')
  const name = 'Joanna Biegaczka'
  await paidEntry(e, email, { firstName: 'Joanna', lastName: 'Biegaczka' })
  const { context, page } = await runnerPage(browser, email)
  const decline = () => page.getByRole('button', { name: 'Odrzuć', exact: true }).click({ timeout: 3000 }).catch(() => {})

  await page.goto('/profil/zapisy'); await decline()
  const row = personRow(page, name)
  await expect(row.getByTestId('self-change')).toBeVisible()
  const transferOnZapisy = await page.getByTestId('transfer-action').count()
  console.log(`ZAPISY transfer-action count: ${transferOnZapisy}`)
  await outlined(page, ['self-change', 'self-edit'])
  await shot(page, 'po-zapisy-where-desktop.png')
  await shot(page, 'po-zapisy-all-actions-desktop.png')
  await page.setViewportSize(PHONE)
  await shot(page, 'po-zapisy-where-390.png')

  await page.setViewportSize(DESKTOP)
  await page.goto(`/events/${e.slug}/zapisano`); await decline()
  await expect(page.getByTestId('self-change')).toBeVisible()
  await expect(page.getByTestId('transfer-action')).toBeVisible()
  await outlined(page, ['self-change', 'self-edit', 'transfer-action'])
  await shot(page, 'po-ra5-all-actions-desktop.png')
  await shot(page, 'po-ra5-where-desktop.png')
  await page.setViewportSize(PHONE)
  await shot(page, 'po-ra5-all-actions-390.png')
  await shot(page, 'po-ra5-where-390.png')
  await context.close()
})
