import crypto from 'node:crypto'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedFreeEvent, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import { orderOk, runnerEmail } from '../helpers/orders.js'

// „Moje zapisy” (W-89 in docs/registration/scenario-matrix.md): the profile tab /profil/zapisy and
// the account menu's „Moje zapisy”, on a 390 px phone. A runner with a confirmed free entry and an
// unpaid order sees both events, the order's badge, total and link, and the link to their entry; a
// new account sees the empty state.

const hex = () => crypto.randomBytes(4).toString('hex')
const PHONE = { width: 390, height: 844 }

let owner
test.beforeAll(async () => {
  owner = await sessionFor(ACTOR_EMAILS.owner)
  const status = await callFn('organizer-status', owner, { clubId: '00000000-0000-4000-8000-0000000000c1' })
  if (!status.body.data.agreementAccepted) {
    await callFn('accept-organizer-agreement', owner, { clubId: '00000000-0000-4000-8000-0000000000c1', version: status.body.data.version })
  }
})

async function runnerContext(browser, email) {
  const session = await sessionFor(email)
  await admin().from('profiles').update({ username: `zap${hex()}` }).eq('id', session.profileId)
  const context = await browser.newContext({ viewport: PHONE })
  await context.addCookies([{
    name: 'leszy_session', value: session.token, domain: 'localhost', path: '/',
    httpOnly: true, secure: false, sameSite: 'Lax',
  }])
  return { context, session }
}

/** Opens a person's „⋯” (portalled to the page) and returns the menu. */
async function openMenu(page, scope, name) {
  const label = `Zarządzaj zgłoszeniem: ${name}`
  await scope.getByRole('button', { name: label, exact: true }).click()
  const menu = page.getByRole('menu', { name: label })
  await expect(menu).toBeVisible()
  return menu
}

async function noOverflow(page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(wide, 'no horizontal scroll at 390 px').toBe(false)
}

test('W-89 the runner’s registrations on /profil/zapisy and in the account menu, at 390 px', async ({ browser }) => {
  const email = runnerEmail('zapisy')
  const { context, session } = await runnerContext(browser, email)

  const free = await createPublishedFreeEvent(owner, { name: `Bieg Zapisany ${hex()}` })
  const { data: consents } = await admin().from('event_consents').select('id').eq('event_id', free.eventId)
  const reg = await callFn('register-free', session, {
    categoryId: free.categoryIds[0],
    person: { firstName: 'Ola', lastName: 'Zapisana', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200' },
    acceptedConsentIds: consents.map((c) => c.id), serviceRegulamin: true,
  })
  expect(reg.status, JSON.stringify(reg.body)).toBe(201)
  const paid = await createPublishedPaidEvent(owner, { name: `Bieg Płatny ${hex()}`, prices: { 'Bieg 9 km': 6000 } })
  const order = await orderOk(paid, { emails: [email] })

  const page = await context.newPage()
  await page.goto('/profil/zapisy')
  const cards = page.getByTestId('zapisy-event')
  await expect(cards).toHaveCount(2)
  // One person per card: „Zamówienie” and „Twój zapis” close that person's „⋯”, behind a divider
  // after the actions (an unpaid entry offers only „Popraw dane”).
  const freeCard = cards.filter({ hasText: 'Bieg Zapisany' })
  await expect(freeCard.getByText('Ola Zapisana')).toBeVisible()
  // Only the event's name is a link on the card itself.
  await expect(freeCard.getByRole('link')).toHaveCount(1)
  let menu = await openMenu(page, freeCard, 'Ola Zapisana')
  // The free event has a single competition, so there is nowhere to move: no „Zmień konkurencję”.
  await expect(menu.getByRole('menuitem')).toHaveText(['Popraw dane', 'Twój zapis'])
  await expect(menu.getByRole('menuitem', { name: 'Twój zapis' })).toHaveAttribute('href', `/events/${free.slug}/zapisano`)
  await expect(menu.getByRole('separator')).toHaveCount(1)
  await page.keyboard.press('Escape')
  const paidCard = cards.filter({ hasText: 'Bieg Płatny' })
  await expect(paidCard.getByText('DO ZAPŁATY')).toBeVisible()
  await expect(paidCard.getByText('60,00 zł')).toBeVisible()
  await expect(paidCard.getByTestId('zapisy-card-menu')).toHaveCount(0)
  menu = await openMenu(page, paidCard, 'Ola Leśna')
  await expect(menu.getByRole('menuitem')).toHaveText(['Popraw dane', 'Zamówienie'])
  await expect(menu.getByRole('separator')).toHaveCount(1)
  await expect(menu.getByRole('menuitem', { name: 'Zamówienie' })).toHaveAttribute('href', `/zamowienie/${order.orderId}`)
  await menu.getByRole('menuitem', { name: 'Zamówienie' }).click()
  await expect(page).toHaveURL(new RegExp(`/zamowienie/${order.orderId}$`))
  await page.goBack()
  await expect(cards).toHaveCount(2)
  await noOverflow(page)
  await expect(page.getByTestId('profil-nav').getByRole('link').first()).toHaveText('Zapisy')
  await page.screenshot({ path: test.info().outputPath('zapisy-390.png'), fullPage: true })

  await page.getByRole('button', { name: /zap/ }).first().click()
  await page.getByTestId('menu-registrations').click()
  await expect(page).toHaveURL(/\/profil\/zapisy$/)
  await context.close()
})

test('W-89 a new account sees the empty state with the calendar link', async ({ browser }) => {
  const { context } = await runnerContext(browser, runnerEmail('pusty'))
  const page = await context.newPage()
  await page.goto('/profil/zapisy')
  await expect(page.getByTestId('zapisy-empty')).toContainText('Nie masz jeszcze zapisów na zawody.')
  await expect(page.getByTestId('zapisy-empty').getByRole('link')).toHaveAttribute('href', '/kalendarz')
  await noOverflow(page)
  await context.close()
})
