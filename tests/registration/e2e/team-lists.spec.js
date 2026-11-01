import crypto from 'node:crypto'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedFreeEvent, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import { dpayReset, dpayTransactions, payMock } from '../helpers/dpayControl.js'

// Plan 5 task 8: the team row on the public start list and in the organizer's Zgłoszenia, and the
// way from RA5 and the order page to the captain's team page. T-73, T-75 and T-76 in
// docs/registration/scenario-matrix.md.

const ZT = '00000000-0000-4000-8000-0000000000c1'
const STAFETA = { name: 'Sztafeta', discipline: 'run', distanceLabel: '4 x 5 km', startTime: '10:00', capacity: 20, kind: 'team', teamMin: 2, teamMax: 5 }
const rand = () => crypto.randomBytes(4).toString('hex')
const address = (tag) => `runner-${tag}-${rand()}@test.local`
const WIDTHS = [390, 1440]

let owner
let captain

test.beforeAll(async () => {
  owner = await sessionFor(ACTOR_EMAILS.owner)
  captain = await sessionFor(ACTOR_EMAILS.runner)
  const status = await callFn('organizer-status', owner, { clubId: ZT })
  if (!status.body.data.agreementAccepted) {
    await callFn('accept-organizer-agreement', owner, { clubId: ZT, version: status.body.data.version })
  }
  await dpayReset()
})
test.beforeEach(async () => { await resetThrottle() })

const person = (over) => ({ lastName: 'Leśny', birthDate: '1987-01-01', gender: 'M', phone: '600300400', ...over })

async function team(event, teamName, { displayedTotal = 0 } = {}) {
  const { data: consents } = await admin().from('event_consents').select('id').eq('event_id', event.eventId)
  const r = await callFn('register-team', captain, {
    categoryId: event.categoryIds[0], teamName,
    members: [
      { person: person({ firstName: 'Ola', lastName: 'Leśna', birthDate: '1988-03-01', gender: 'K', email: ACTOR_EMAILS.runner, city: 'Gliwice' }) },
      { person: person({ firstName: 'Piotr', email: address('piotr') }) },
      { person: person({ firstName: 'Ewa', gender: 'K', email: address('ewa') }) },
      { person: person({ firstName: 'Jan', email: address('jan') }) },
    ],
    membersConsent: true, acceptedConsentIds: consents.map((c) => c.id), serviceRegulamin: true, displayedTotal,
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.data
}

const acceptAll = async (teamId) => {
  const { error } = await admin().from('registrations').update({ consent_state: 'accepted' }).eq('team_id', teamId)
  if (error) throw error
}

async function open(context, width, path) {
  const page = await context.newPage()
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  await page.setViewportSize({ width, height: 900 })
  await page.goto(path)
  return page
}

async function noOverflow(page) {
  const wrapped = await page.locator('button:visible, a[data-action]:visible').evaluateAll((els) => els
    .filter((e) => e.getClientRects().length > 1 || e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().height > 60)
    .map((e) => e.textContent))
  expect(wrapped).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

const zgloszenia = (eventId) => `/klub/zatyrani-test/wydarzenia/${eventId}/zgloszenia`

async function paidTeam() {
  const event = await createPublishedPaidEvent(owner, { competitions: [STAFETA], prices: { Sztafeta: 24000 } })
  const out = await team(event, 'Wilcze Stado', { displayedTotal: 24000 })
  await payMock((await dpayTransactions()).at(-1).id, 'paid')
  await expect(async () => {
    const r = await callFn('list-event-registrations', owner, { eventId: event.eventId })
    expect(r.body.teams[0].paymentStatus).toBe('paid')
  }).toPass({ timeout: 15000 })
  return { event, ...out }
}

for (const width of WIDTHS) {
  test(`T-73 ${width} px: the viewer reads the team as one row, the owner opens it to its 4 members`, async ({ actors }) => {
    const { event, teamId } = await paidTeam()
    await acceptAll(teamId)

    const viewer = await open(actors.viewer, width, `/events/${event.slug}/lista`)
    const entries = viewer.getByTestId('start-list-entry')
    await expect(entries).toHaveCount(1)
    await expect(entries.first()).toContainText('Wilcze Stado')
    for (const first of ['Ola', 'Piotr', 'Ewa', 'Jan']) await expect(entries.first()).toContainText(first)
    await expect(entries.first()).not.toContainText('Leśn')
    await expect(viewer.getByTestId('list-competition')).toContainText('Sztafeta · drużyny')
    await expect(viewer.getByTestId('list-competition')).toContainText('1 / 20 miejsc')
    if (width === 390) {
      await expect(entries.first()).toContainText(/sztafeta · 4 osoby/i)
    } else {
      const cells = entries.first().locator('td')
      await expect(cells.nth(1)).toHaveText('Gliwice')
      await expect(cells.nth(2)).toHaveText('—')
      await expect(cells.nth(4)).toHaveText('4 osoby')
    }
    await noOverflow(viewer)

    if (width === 390) await viewer.getByTestId('filter-toggle').click()
    await viewer.getByLabel('Szukaj').fill('piotr')
    await expect(entries).toHaveCount(1)
    await viewer.getByLabel('Szukaj').fill('leśny')
    await expect(entries).toHaveCount(0)

    const org = await open(actors.owner, width, zgloszenia(event.eventId))
    const scope = org.getByTestId(width === 390 ? 'registrations-cards' : 'registrations')
    const row = scope.getByTestId('team-row')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('Wilcze Stado · 4 os.')
    await expect(row).toContainText('kapitan: Ola Leśna')
    await expect(row).toContainText('OPŁACONA')
    await expect(row).toContainText('ZGODY 4/4')
    await expect(row).toContainText('240,00 zł')
    await expect(scope.getByTestId('team-member')).toHaveCount(0)
    const toggle = row.getByRole('button', { name: 'Skład — Wilcze Stado' })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(scope.getByTestId('team-member')).toHaveCount(4)
    await expect(scope.getByTestId('team-member').filter({ hasText: 'Piotr Leśny' })).toHaveCount(1)
    await noOverflow(org)
    await toggle.click()
    await expect(scope.getByTestId('team-member')).toHaveCount(0)
  })
}

test('T-73 an expanded team keeps Plan 4\'s reminder and office mark in each member\'s ⋯; „Czeka na zgody” opens the team that holds them', async ({ actors }) => {
  const event = await createPublishedFreeEvent(owner, { competitions: [STAFETA] })
  await team(event, 'Czekający')
  const org = await open(actors.owner, 1440, zgloszenia(event.eventId))
  const scope = org.getByTestId('registrations')
  const row = scope.getByTestId('team-row')
  await expect(row).toContainText('ZGODY 1/4')
  await expect(row).toContainText('ZAPISANA')
  await org.getByTestId('status-chips').getByRole('button', { name: 'Czeka na zgody · 3' }).click()
  await expect(scope.getByTestId('team-member')).toHaveCount(3)
  await org.getByRole('button', { name: 'Akcje — Piotr Leśny' }).click()
  await expect(org.getByRole('menuitem', { name: 'Przypomnij o akceptacji regulaminu' })).toBeVisible()
  await expect(org.getByRole('menuitem', { name: 'Regulamin podpisany w biurze' })).toBeVisible()
  await org.keyboard.press('Escape')
  expect(await scope.evaluate((e) => e.scrollWidth <= e.clientWidth), 'a member\'s ⋯ stays in view').toBe(true)
})

test('T-73 a pending team reads CZEKA NA WPŁATĘ with its fee in Zgłoszenia, and only as a count on the list', async ({ actors }) => {
  const event = await createPublishedPaidEvent(owner, { competitions: [STAFETA], prices: { Sztafeta: 24000 } })
  await team(event, 'Na Później', { displayedTotal: 24000 })
  const viewer = await open(actors.viewer, 390, `/events/${event.slug}/lista`)
  await expect(viewer.getByTestId('list-competition')).toContainText('+1 czeka na wpłatę')
  await expect(viewer.getByTestId('start-list')).not.toContainText('Na Później')
  const org = await open(actors.owner, 390, zgloszenia(event.eventId))
  const row = org.getByTestId('registrations-cards').getByTestId('team-row')
  await expect(row).toContainText('CZEKA NA WPŁATĘ')
  await expect(row).toContainText('240,00 zł')
  await org.setViewportSize({ width: 1440, height: 900 })
  const table = org.getByTestId('registrations')
  await expect(table.getByTestId('team-row')).toBeVisible()
  expect(await table.evaluate((e) => e.scrollWidth <= e.clientWidth), 'the fee must not push ⋯ out').toBe(true)
})

test('T-75 the captain gets from RA5 and from the order page, pending or paid, to the team page; a member\'s RA5 has no such link', async ({ actors }) => {
  const free = await createPublishedFreeEvent(owner, { competitions: [STAFETA] })
  const { teamId } = await team(free, 'Z Zapisano')
  const done = await open(actors.runner, 390, `/events/${free.slug}/zapisano`)
  await expect(done.getByRole('link', { name: 'Zarządzaj składem' })).toHaveAttribute('href', `/events/${free.slug}/druzyna/${teamId}`)
  await noOverflow(done)

  const event = await createPublishedPaidEvent(owner, { competitions: [STAFETA], prices: { Sztafeta: 24000 } })
  const paid = await team(event, 'Z Zamówienia', { displayedTotal: 24000 })
  const path = `/events/${event.slug}/druzyna/${paid.teamId}`
  const order = await open(actors.runner, 390, `/zamowienie/${paid.orderId}`)
  await expect(order.getByTestId('order-pending')).toBeVisible()
  await expect(order.getByRole('link', { name: 'Zarządzaj składem' })).toHaveAttribute('href', path)
  await payMock((await dpayTransactions()).at(-1).id, 'paid')
  await expect(async () => {
    await order.reload()
    await expect(order.getByTestId('order-paid')).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15000 })
  await expect(order.getByRole('link', { name: 'Zarządzaj składem' })).toHaveAttribute('href', path)
  await noOverflow(order)

  const individual = await open(actors.owner, 390, `/events/${free.slug}/zapisano`)
  await expect(individual.getByRole('link', { name: 'Zarządzaj składem' })).toHaveCount(0)
})

test('T-76 the published header counts teams against the teams limit; the wizard\'s limit word agrees with its number', async ({ actors }) => {
  const event = await createPublishedFreeEvent(owner, { competitions: [{ ...STAFETA, capacity: 1 }] })
  await team(event, 'Jedyna')
  const page = await open(actors.owner, 1440, zgloszenia(event.eventId))
  await expect(page.getByTestId('registered-count')).toHaveText('1 / 1 drużyna')
  await page.goto(`/klub/zatyrani-test/wydarzenia/${event.eventId}/konkurencje`)
  await expect(page.getByTestId('capacity-unit')).toHaveText('DRUŻYNA')
})
