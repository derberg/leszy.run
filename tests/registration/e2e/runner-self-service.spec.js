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
const menuLabel = (name) => `Zarządzaj zgłoszeniem: ${name}`
const trigger = (scope, name) => scope.getByRole('button', { name: menuLabel(name), exact: true })

/** Opens the person's „⋯” menu (it is portalled to the page, not inside the row) and returns it. */
async function openMenu(page, scope, name) {
  await trigger(scope, name).click()
  const menu = page.getByRole('menu', { name: menuLabel(name) })
  await expect(menu).toBeVisible()
  return menu
}

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
  let menu = await openMenu(page, row, name)
  // A card with one person: the card's links close that person's menu, behind a divider.
  await expect(menu.getByRole('menuitem')).toHaveText(['Zmień konkurencję', 'Popraw dane', 'Zamówienie', 'Twój zapis'])
  await expect(menu.getByRole('separator')).toHaveCount(1)
  await expect(menu.getByRole('menuitem', { name: 'Zamówienie' })).toHaveAttribute('href', `/zamowienie/${entry.orderId}`)
  await expect(menu.getByRole('menuitem', { name: 'Twój zapis' })).toHaveAttribute('href', `/events/${e.slug}/zapisano`)
  await shot(page, 'po-zapisy-actions-desktop.png')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await page.setViewportSize(PHONE)
  menu = await openMenu(page, row, name)
  for (const b of await menu.getByRole('menuitem').all()) {
    expect((await b.boundingBox()).height, 'a menu item stays on one line').toBeLessThan(48)
  }
  await noOverflow(page)
  await shot(page, 'po-zapisy-actions-390.png')

  await menu.getByRole('menuitem', { name: 'Zmień konkurencję' }).click()
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
  // Only „Popraw dane” is left of the actions.
  await expect((await openMenu(page, personRow(page, name), name)).getByRole('menuitem')).toHaveText(['Popraw dane', 'Zamówienie', 'Twój zapis'])
  await page.keyboard.press('Escape')
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
  await (await openMenu(page, personRow(page, name), name)).getByRole('menuitem', { name: 'Popraw dane' }).click()
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
  await expect(trigger(personRow(page, name), name)).toBeVisible()
  await setSettings(e.eventId, { runner_competition_change: false, runner_data_edit: false })
  await toZapisy(page)
  await expect(personRow(page, name)).toBeVisible()
  // The ⋯ stays for the card's links alone, with no divider.
  const menu = await openMenu(page, personRow(page, name), name)
  await expect(menu.getByRole('menuitem')).toHaveText(['Zamówienie', 'Twój zapis'])
  await expect(menu.getByRole('separator')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(personRow(page, name).getByTestId('self-service')).toHaveCount(0)
  await context.close()
})

// Review screenshots only (written when the review directory exists): where the runner finds the actions.
// The red outline is injected here and never ships in the app.
const OUTLINE = '{ outline: 3px solid #e00 !important; outline-offset: 3px; }'
async function outlined(page, testIds) {
  return page.addStyleTag({ content: testIds.map((t) => `[data-testid="${t}"] ${OUTLINE}`).join('\n') })
}

/**
 * The person's „⋯” sits at the right end of the person's own line (no extra row) and opens a menu of
 * the three actions, in order, each on one line, inside the viewport and right-aligned to the trigger.
 */
async function menuOnTheLine(page, scope, name, nameLocator, expected = ['Zmień konkurencję', 'Popraw dane', 'Przekaż pakiet']) {
  const t = trigger(scope, name)
  await expect(t).toHaveCount(1)
  await expect(t).toHaveAttribute('aria-haspopup', 'menu')
  await expect(t).toHaveAttribute('aria-expanded', 'false')
  const [tb, nb, sb] = await Promise.all([t.boundingBox(), nameLocator.boundingBox(), scope.boundingBox()])
  expect(Math.abs((tb.y + tb.height / 2) - (nb.y + nb.height / 2)), 'the trigger is on the name line').toBeLessThan(12)
  expect(sb.x + sb.width - (tb.x + tb.width), 'the trigger ends the line').toBeLessThan(20)
  const menu = await openMenu(page, scope, name)
  await expect(t).toHaveAttribute('aria-expanded', 'true')
  await expect(menu.getByRole('menuitem')).toHaveText(expected)
  const mb = await menu.boundingBox()
  const vw = page.viewportSize().width
  expect(mb.x, 'inside the viewport').toBeGreaterThanOrEqual(0)
  expect(mb.x + mb.width, 'inside the viewport').toBeLessThanOrEqual(vw)
  expect(Math.abs(mb.x + mb.width - (tb.x + tb.width)), 'right-aligned to the trigger').toBeLessThan(2)
  for (const item of await menu.getByRole('menuitem').all()) {
    expect((await item.boundingBox()).height, 'an item stays on one line').toBeLessThan(48)
  }
  await noOverflow(page)
  return menu
}

test('RS-18 one ⋯ menu per runner on Moje zapisy and RA5: Zmień konkurencję, Popraw dane, Przekaż pakiet (screenshots)', async ({ browser }) => {
  await resetThrottle()
  const e = await createPublishedPaidEvent(owner, { name: `Bieg Leśny ${crypto.randomBytes(3).toString('hex')}`, competitions: COMPETITIONS, prices: PRICES })
  await enableTransfers(e)
  const email = runnerEmail('gdzie')
  const name = 'Joanna Biegaczka'
  const entry = await paidEntry(e, email, { firstName: 'Joanna', lastName: 'Biegaczka' })
  const { context, page } = await runnerPage(browser, email)
  const decline = () => page.getByRole('button', { name: 'Odrzuć', exact: true }).click({ timeout: 3000 }).catch(() => {})

  // „Moje zapisy”: the menu holds „Przekaż pakiet” too, to the same RA6 address as RA5.
  await page.goto('/profil/zapisy'); await decline()
  const row = personRow(page, name)
  const rowName = row.getByText(name, { exact: false }).first()
  const ZAPISY_ITEMS = ['Zmień konkurencję', 'Popraw dane', 'Przekaż pakiet', 'Zamówienie', 'Twój zapis']
  let menu = await menuOnTheLine(page, row, name, rowName, ZAPISY_ITEMS)
  await expect(menu.getByRole('separator')).toHaveCount(1)
  await expect(menu.getByRole('menuitem', { name: 'Przekaż pakiet' }))
    .toHaveAttribute('href', `/events/${e.slug}/przekaz/${entry.registrationId}`)
  // Click outside closes it.
  await page.mouse.click(5, 300)
  await expect(menu).toHaveCount(0)
  let style = await outlined(page, ['self-menu'])
  await shot(page, 'po-zapisy-where-desktop.png')
  await shot(page, 'po-zapisy-all-actions-desktop.png')
  await page.setViewportSize(PHONE)
  expect((await row.boundingBox()).height, 'one line per person').toBeLessThan(34)
  await noOverflow(page)
  await shot(page, 'po-zapisy-where-390.png')
  await shot(page, 'po-zapisy-all-actions-390.png')
  // Status and amount stay on the card; the links left it.
  await expect(page.getByTestId('zapisy-event').getByRole('link', { name: /Zamówienie|Twój zapis/ })).toHaveCount(0)
  await style.evaluate((el) => el.remove())
  menu = await menuOnTheLine(page, row, name, rowName, ZAPISY_ITEMS)
  await shot(page, 'po-zapisy-menu-open-390.png')
  // The item navigates like the old link did.
  await menu.getByRole('menuitem', { name: 'Przekaż pakiet' }).click()
  await expect(page).toHaveURL(new RegExp(`/events/${e.slug}/przekaz/${entry.registrationId}$`))

  await page.setViewportSize(DESKTOP)
  await page.goto(`/events/${e.slug}/zapisano`); await decline()
  const card = page.getByTestId('done-person').filter({ hasText: name })
  const cardName = card.getByText(name, { exact: true })
  menu = await menuOnTheLine(page, card, name, cardName)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger(card, name)).toBeFocused()
  style = await outlined(page, ['self-menu'])
  await shot(page, 'po-ra5-all-actions-desktop.png')
  await shot(page, 'po-ra5-where-desktop.png')
  await page.setViewportSize(PHONE)
  await noOverflow(page)
  await shot(page, 'po-ra5-all-actions-390.png')
  await shot(page, 'po-ra5-where-390.png')
  await style.evaluate((el) => el.remove())
  menu = await menuOnTheLine(page, card, name, cardName)
  await shot(page, 'po-ra5-menu-open-390.png')
  await context.close()
})

test('RS-18 a card with two people: no header ⋯, each person one ⋯ with their actions, a divider and Zamówienie / Twoje zapisy (screenshots)', async ({ browser }) => {
  await resetThrottle()
  await dpayReset()
  const eventName = `Bieg Rodzinny ${crypto.randomBytes(3).toString('hex')}`
  const e = await createPublishedPaidEvent(owner, { name: eventName, competitions: COMPETITIONS, prices: PRICES })
  const email = runnerEmail('grupa')
  const name = 'Joanna Biegaczka'
  const other = 'Piotr Biegacz'
  const out = await orderOk(e, {
    categoryId: e.categoryIds[0],
    people: [person(email, { firstName: 'Joanna', lastName: 'Biegaczka' }),
      person(runnerEmail('grupa2'), { firstName: 'Piotr', lastName: 'Biegacz', gender: 'M', ageGroupLabel: 'M open' })],
  })
  const paid = await callFn('pay-order', await sessionFor(email), { orderId: out.orderId })
  expect(paid.status, JSON.stringify(paid.body)).toBe(200)
  await payMock(await latestTxn(out.orderId), 'paid')
  await expect.poll(async () => (await orderOf(out.orderId)).status, { timeout: 15_000 }).toBe('paid')
  const { context, page } = await runnerPage(browser, email)
  await page.setViewportSize(PHONE)

  await toZapisy(page)
  const card = page.getByTestId('zapisy-event').filter({ hasText: eventName })
  await expect(card.getByTestId('zapisy-person')).toHaveCount(2)
  // No header ⋯: the card has exactly one trigger per person, each on that person's line.
  await expect(card.getByTestId('zapisy-card-menu')).toHaveCount(0)
  await expect(card.getByRole('button', { name: `Zgłoszenie: ${eventName}`, exact: true })).toHaveCount(0)
  await expect(card.getByTestId('self-menu')).toHaveCount(2)
  await expect(trigger(personRow(page, name), name)).toHaveCount(1)
  await expect(trigger(personRow(page, other), other)).toHaveCount(1)
  await expect(card.getByRole('link', { name: /Zamówienie|Twój zapis|Twoje zapisy/ })).toHaveCount(0)
  await noOverflow(page)
  const style = await outlined(page, ['self-menu'])
  await shot(page, 'po-zapisy-group-390.png')
  await style.evaluate((el) => el.remove())

  // Joanna (the buyer): her actions, a divider, then the card's links.
  let menu = await openMenu(page, personRow(page, name), name)
  await expect(menu.getByRole('menuitem')).toHaveText(['Zmień konkurencję', 'Popraw dane', 'Zamówienie', 'Twoje zapisy'])
  await expect(menu.getByRole('separator')).toHaveCount(1)
  await expect(menu.getByRole('menuitem', { name: 'Zamówienie' })).toHaveAttribute('href', `/zamowienie/${out.orderId}`)
  await expect(menu.getByRole('menuitem', { name: 'Twoje zapisy' })).toHaveAttribute('href', `/events/${e.slug}/zapisano`)
  const tb = await trigger(personRow(page, name), name).boundingBox()
  const mb = await menu.boundingBox()
  expect(mb.x + mb.width, 'inside the viewport').toBeLessThanOrEqual(PHONE.width)
  expect(Math.abs(mb.x + mb.width - (tb.x + tb.width)), 'right-aligned to the trigger').toBeLessThan(2)
  await noOverflow(page)
  await shot(page, 'po-zapisy-group-menu-open-390.png')
  await page.keyboard.press('Escape')

  // Piotr (the added adult, no action): the two links only, no divider.
  menu = await openMenu(page, personRow(page, other), other)
  await expect(menu.getByRole('menuitem')).toHaveText(['Zamówienie', 'Twoje zapisy'])
  await expect(menu.getByRole('separator')).toHaveCount(0)
  await expect(menu.getByRole('menuitem').first()).toBeFocused()
  await noOverflow(page)
  await shot(page, 'po-zapisy-group-menu2-open-390.png')
  // Keyboard: ArrowDown moves to the second link, Enter follows it.
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Twoje zapisy' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/events/${e.slug}/zapisano$`))
  await context.close()
})
