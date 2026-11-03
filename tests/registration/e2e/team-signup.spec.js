import crypto from 'node:crypto'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedFreeEvent, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import { dpayReset, dpayTransactions } from '../helpers/dpayControl.js'
import { lastCodeFor, messagesTo } from '../helpers/emailCapture.js'
import { DPAY_MOCK_PORT } from '../helpers/dpayMock.js'

// Plan 5 task 7a: the runner's team sign-up, RB1 captain → RB2 squad → RB3 payment, and the RA1
// team card: T-62 and T-63 in docs/registration/scenario-matrix.md. T-66 one member on screen at
// a time with the list step; T-67 leg order; T-68 the code step and Back. helpers/teams.js imports
// money.js, which Playwright's loader reads as CommonJS, so its fixtures are repeated here.

const ZT = '00000000-0000-4000-8000-0000000000c1'
const STAFETA = (over = {}) => ({
  name: 'Sztafeta', discipline: 'run', distanceLabel: '4 x 5 km', startTime: '10:00', capacity: 20, kind: 'team', teamMin: 2, teamMax: 4, ...over,
})
const PAY_PAGE = new RegExp(`localhost:${DPAY_MOCK_PORT}\\/pay\\/`)
const DUPLICATE = 'Ta osoba jest już zapisana na te zawody.'
const NAME_TAKEN = 'Ta nazwa drużyny jest już zajęta.'
const rand = () => crypto.randomBytes(4).toString('hex')
const address = (tag) => `runner-${tag}-${rand()}@test.local`
const name = () => `Wilcze Stado ${rand()}`
const WIDTHS = [390, 1440]

let owner

test.beforeAll(async () => {
  owner = await sessionFor(ACTOR_EMAILS.owner)
  const status = await callFn('organizer-status', owner, { clubId: ZT })
  if (!status.body.data.agreementAccepted) {
    await callFn('accept-organizer-agreement', owner, { clubId: ZT, version: status.body.data.version })
  }
  await dpayReset()
})
// One runner signs up many teams here: the per-buyer caps start empty.
test.beforeEach(async () => { await resetThrottle() })

async function setUp(context, width) {
  const page = await context.newPage()
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  await page.setViewportSize({ width, height: 900 })
  return page
}

const freeEvent = (over) => createPublishedFreeEvent(owner, { competitions: [STAFETA(over)] })
const paidEvent = (over) => createPublishedPaidEvent(owner, { competitions: [STAFETA(over)], prices: { Sztafeta: 24000 } })

async function setLegOrder(categoryId) {
  const { error } = await admin().from('competitions').update({ leg_order_enabled: true }).eq('category_id', categoryId)
  if (error) throw error
}

async function fillCard(page, prefix, { first, last = 'Leśny', birth = '1987-01-01', gender = 'Mężczyzna', email, phone = '600300400' }) {
  await page.locator(`#${prefix}-first`).fill(first)
  await page.locator(`#${prefix}-last`).fill(last)
  await page.locator(`#${prefix}-birth`).fill(birth)
  await page.locator(`[aria-labelledby="${prefix}-gender-label"]`).getByRole('button', { name: gender, exact: true }).click()
  if (email !== undefined) await page.locator(`#${prefix}-email`).fill(email)
  // An adult member's card has no phone until „Pokaż więcej pól”: the member gives it on /zgoda.
  if (phone !== undefined && await page.locator(`#${prefix}-phone`).count()) await page.locator(`#${prefix}-phone`).fill(phone)
}

async function tickAll(page) {
  const boxes = page.getByTestId('consents').getByRole('checkbox')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
}

const CAPTAIN = { first: 'Ola', last: 'Leśna', birth: '1988-03-01', gender: 'Kobieta', phone: '600100200' }

/** RA1 → RB1, filled in; the runner's session holds this address, so no code is asked. */
async function fillCaptain(page, event, { teamName, size, email = ACTOR_EMAILS.runner }) {
  await page.goto(`/events/${event.slug}`)
  await page.getByTestId('competition').first().click()
  await expect(page.getByTestId('team-captain')).toBeVisible()
  await page.getByLabel('Nazwa drużyny').fill(teamName)
  if (size) await page.getByTestId('team-size').getByRole('button', { name: String(size), exact: true }).click()
  await fillCard(page, 'p', { ...CAPTAIN, email })
  await tickAll(page)
}

/** RB1 → the first member's step. */
async function toSquad(page, event, opts) {
  await fillCaptain(page, event, opts)
  await page.getByRole('button', { name: 'Dalej: skład' }).click()
  await expect(page.getByTestId('member-card')).toBeVisible()
}

/** Fills the member on screen and goes on. */
async function nextMember(page, prefix, person) {
  await fillCard(page, prefix, person)
  await page.getByTestId('person-done').click()
}

/** A team with one other captain, holding these members (free or paid alike). */
async function otherTeam(event, members, teamName = name(), displayedTotal = 0) {
  const email = address('other')
  const session = await sessionFor(email)
  const { data: consents } = await admin().from('event_consents').select('id').eq('event_id', event.eventId)
  const person = (p) => ({ firstName: 'Jan', lastName: 'Bór', birthDate: '1985-01-01', gender: 'M', phone: '600700800', ...p })
  const r = await callFn('register-team', session, {
    categoryId: event.categoryIds[0], teamName,
    members: [{ person: person({ email }) }, ...members.map((m) => (m.guardianConsent ? m : { person: person(m) }))],
    membersConsent: true, acceptedConsentIds: consents.map((c) => c.id), serviceRegulamin: true, displayedTotal,
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r
}

async function noButtonWraps(page) {
  const wrapped = await page.locator('button:visible').evaluateAll((els) => els
    .filter((e) => getComputedStyle(e).whiteSpace !== 'nowrap' && e.getClientRects().length > 1 || e.scrollWidth > e.clientWidth + 1)
    .map((e) => e.textContent))
  expect(wrapped).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

for (const width of WIDTHS) {
  test(`T-62 (a) ${width} px: a member already registered → the error under that card's e-mail, the others intact`, async ({ actors }) => {
    const taken = address('taken')
    const event = await freeEvent()
    await otherTeam(event, [{ email: taken }])
    const page = await setUp(actors.runner, width)

    await toSquad(page, event, { teamName: name(), size: 3 })
    await nextMember(page, 'p2', { first: 'Piotr', email: address('piotr') })
    await nextMember(page, 'p3', { first: 'Ewa', gender: 'Kobieta', email: taken })
    await page.getByTestId('members-consent').check()
    await page.getByRole('button', { name: 'Zapisz drużynę' }).click()

    await expect(page.locator('#p3-email-error')).toHaveText(DUPLICATE)
    await expect(page.locator('#p3-email')).toBeFocused()
    await expect(page.getByTestId('member-card')).toHaveCount(1)
    await expect(page.locator('#p3-first')).toHaveValue('Ewa')
    await noButtonWraps(page)

    // The other cards are as they were, and the corrected squad goes through.
    await page.locator('#p3-email').fill(address('ewa'))
    await page.getByTestId('person-done').click()
    await expect(page.getByTestId('person-row').nth(1)).toContainText('Piotr Leśny')
    await page.getByRole('button', { name: 'Zapisz drużynę' }).click()
    await expect(page.getByTestId('done')).toBeVisible()
  })

  test(`T-62 (b) ${width} px: a taken name → under „Nazwa drużyny” on RB1, the squad kept`, async ({ actors }) => {
    const teamName = name()
    const free = await freeEvent()
    await otherTeam(free, [{ email: address('filler') }], teamName)
    const page = await setUp(actors.runner, width)

    // The same name in another case and spacing.
    await toSquad(page, free, { teamName: `  ${teamName.toUpperCase().replace(' ', '  ')} ` })
    await nextMember(page, 'p2', { first: 'Piotr', email: address('piotr') })
    await page.getByTestId('members-consent').check()
    await page.getByRole('button', { name: 'Zapisz drużynę' }).click()

    await expect(page.locator('#team-name-error')).toHaveText(NAME_TAKEN)
    await expect(page.getByTestId('team-captain')).toBeVisible()
    await expect(page.locator('#team-name')).toBeFocused()
    await noButtonWraps(page)

    await page.getByLabel('Nazwa drużyny').fill(name())
    await page.getByRole('button', { name: 'Dalej: skład' }).click()
    await expect(page.getByTestId('person-row').nth(1)).toContainText('Piotr Leśny')
    await page.getByRole('button', { name: 'Zapisz drużynę' }).click()
    await expect(page.getByTestId('done')).toBeVisible()
  })
}

test('T-62 (c) RB3: one fee, numbered members, no charge of LESZY.RUN, „Zapłać” on at once, dpay after it', async ({ actors }) => {
  const event = await paidEvent()
  const page = await setUp(actors.runner, 390)
  const teamName = name()
  await toSquad(page, event, { teamName })
  await nextMember(page, 'p2', { first: 'Piotr', email: address('piotr') })
  await page.getByTestId('members-consent').check()
  await page.getByRole('button', { name: 'Dalej: płatność' }).click()

  const checkout = page.getByTestId('checkout')
  await expect(checkout.getByRole('heading', { name: 'Jedna opłata za drużynę' })).toBeVisible()
  await expect(page.getByTestId('team-member')).toHaveCount(2)
  await expect(page.getByTestId('team-member').first()).toContainText('1')
  await expect(page.getByTestId('checkout-line')).toHaveCount(1)
  await expect(page.getByTestId('checkout-line')).toContainText('Sztafeta · drużyna 2-osobowa')
  await expect(page.getByTestId('checkout-line-price')).toHaveText('240,00 zł')
  await expect(page.getByTestId('checkout-total')).toContainText('240,00 zł')
  await expect(checkout).toContainText('Skład możesz zmieniać do zamknięcia zapisów.')
  await expect(checkout).not.toContainText(/Miejsce dla drużyny|wspar/i)
  await expect(page.getByLabel('Kod (6 cyfr)')).toHaveCount(0)
  await expect(page.getByTestId('pay')).toBeEnabled()
  await noButtonWraps(page)

  await page.getByTestId('pay').click()
  await expect(page).toHaveURL(PAY_PAGE)
  const [tx] = await dpayTransactions()
  expect(tx).toBeTruthy()
  const { data: team } = await admin().from('teams').select('id').eq('name', teamName).single()
  const { data: rows } = await admin().from('registrations').select('order_id').eq('team_id', team.id)
  const orderId = rows[0].order_id
  expect(orderId).toBeTruthy()

  // Back from dpay lands on the order, never on this step (D5-26).
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/zamowienie/${orderId}$`))
})

test('T-62 (a)(b) on a paid team: „Zapłać” refused → the member\'s e-mail, then the name on RB1, with the squad kept', async ({ actors }) => {
  const event = await paidEvent()
  const taken = address('taken')
  const takenName = name()
  await otherTeam(event, [{ email: taken }], takenName, 24000)
  const page = await setUp(actors.runner, 390)

  await toSquad(page, event, { teamName: takenName })
  await nextMember(page, 'p2', { first: 'Piotr', email: taken })
  await page.getByTestId('members-consent').check()
  await page.getByRole('button', { name: 'Dalej: płatność' }).click()
  await page.getByTestId('pay').click()
  // The name is refused first: the RPC writes the team before its people.
  await expect(page.locator('#team-name-error')).toHaveText(NAME_TAKEN)
  await page.getByLabel('Nazwa drużyny').fill(name())
  await page.getByRole('button', { name: 'Dalej: skład' }).click()

  await expect(page.getByTestId('person-row').nth(1)).toContainText('Piotr Leśny')
  await page.getByRole('button', { name: 'Dalej: płatność' }).click()
  await page.getByTestId('pay').click()
  await expect(page.locator('#p2-email-error')).toHaveText(DUPLICATE)
  await expect(page.locator('#p2-first')).toHaveValue('Piotr')
})

test('T-62 RA1: the team card reads „Drużyny N–M osób · <cena> / drużyna · X / Y DRUŻYN”', async ({ actors }) => {
  const event = await paidEvent()
  const page = await setUp(actors.viewer, 390)
  await page.goto(`/events/${event.slug}`)
  await expect(page.getByTestId('team-line')).toHaveText('Drużyny 2–4 osób · 240 zł / drużyna · 0 / 20 DRUŻYN')
  // Final review I-5: an event of teams only counts drużyny, never people.
  await expect(page.getByTestId('stat-registered')).toContainText('0 drużyn')
  await expect(page.getByTestId('stat-registered')).not.toContainText('osób')
  await expect(page.getByTestId('stat-free')).toContainText('20 dla drużyn')
})

test('T-62 M-1 RB1 says under the name that it is public', async ({ actors }) => {
  const event = await freeEvent()
  const page = await setUp(actors.runner, 390)
  await page.goto(`/events/${event.slug}`)
  await page.getByTestId('competition').first().click()
  const note = page.getByTestId('team-name-public')
  await expect(note).toHaveText('Nazwa drużyny będzie widoczna na publicznej liście startowej. To nie jest klub. Klub podaje każda osoba osobno, a w jednej drużynie mogą być osoby z różnych klubów.')
  await expect(page.getByLabel('Nazwa drużyny')).toHaveAccessibleDescription('Nazwa drużyny będzie widoczna na publicznej liście startowej. To nie jest klub. Klub podaje każda osoba osobno, a w jednej drużynie mogą być osoby z różnych klubów.')
})

for (const width of WIDTHS) {
  test(`T-63 ${width} px: a free team ends on RA5 with the squad and the consent tags`, async ({ actors }) => {
    const event = await freeEvent()
    const page = await setUp(actors.runner, width)
    const piotr = address('piotr')
    const teamName = name()
    await toSquad(page, event, { teamName, size: 3 })
    await nextMember(page, 'p2', { first: 'Piotr', email: piotr })
    await expect(page.getByTestId('member-card')).toHaveCount(1)
    await fillCard(page, 'p3', { first: 'Zosia', last: 'Leśna', birth: '2014-05-05', gender: 'Dziewczynka', email: undefined, phone: undefined })
    await page.getByTestId('person-done').click()
    // A child is asked for the guardian's box on their own step.
    await expect(page.getByTestId('guardian-consent')).toBeVisible()
    await page.getByTestId('guardian-consent').check()
    await page.getByTestId('person-done').click()

    await expect(page.getByTestId('person-row').first()).toContainText('Ola Leśna')
    await expect(page.getByTestId('person-row').first()).toContainText('KAPITAN ✓')
    await expect(page.getByTestId('person-row').nth(2)).toContainText('OPIEKUN: KAPITAN')
    await expect(page.getByTestId('person-row').nth(2)).toContainText('12 LAT')
    await expect(page.getByTestId('squad-submit')).toBeDisabled()
    await page.getByTestId('members-consent').check()
    await noButtonWraps(page)
    await page.getByRole('button', { name: 'Zapisz drużynę' }).click()

    await expect(page).toHaveURL(new RegExp(`/events/${event.slug}/zapisano$`))
    await expect(page.getByTestId('done-team')).toContainText(teamName)
    const rows = page.getByTestId('done-person')
    await expect(rows).toHaveCount(3)
    await expect(rows.filter({ hasText: 'Ola Leśna' })).toContainText('✓ REGULAMIN')
    await expect(rows.filter({ hasText: 'Piotr Leśny' })).toContainText('CZEKA NA ZGODĘ')
    await expect(rows.filter({ hasText: 'Zosia Leśna' })).toContainText('✓ OPIEKUN')
    await expect.poll(async () => (await messagesTo(piotr)).length).toBeGreaterThan(0)
  })
}

test('T-62 a child\'s duplicate has no e-mail field: it shows on the child\'s card', async ({ actors }) => {
  const event = await freeEvent()
  const child = { person: { firstName: 'Zosia', lastName: 'Leśna', birthDate: '2014-05-05', gender: 'K', phone: '600700800' }, guardianConsent: true }
  await otherTeam(event, [child])
  const page = await setUp(actors.runner, 390)
  await toSquad(page, event, { teamName: name() })
  await fillCard(page, 'p2', { first: 'Zosia', last: 'Leśna', birth: '2014-05-05', gender: 'Dziewczynka', email: undefined, phone: undefined })
  await page.getByTestId('guardian-consent').check()
  await page.getByTestId('person-done').click()
  await page.getByTestId('members-consent').check()
  await page.getByRole('button', { name: 'Zapisz drużynę' }).click()
  await expect(page.locator('#p2-first-error')).toHaveText(DUPLICATE)
  await expect(page.locator('#p2-email')).toHaveCount(0)
})

test('T-62 the honeypot: a 200 with no data leaves nothing written and no crash', async ({ actors }) => {
  const event = await freeEvent()
  const page = await setUp(actors.runner, 390)
  const teamName = name()
  await fillCaptain(page, event, { teamName })
  await page.locator('input[name="website"]').fill('https://spam.example')
  await page.getByRole('button', { name: 'Dalej: skład' }).click()
  await nextMember(page, 'p2', { first: 'Piotr', email: address('piotr') })
  await page.getByTestId('members-consent').check()
  await page.getByRole('button', { name: 'Zapisz drużynę' }).click()
  await expect(page).toHaveURL(new RegExp(`/events/${event.slug}/zapisano$`))
  const { data } = await admin().from('teams').select('id').eq('name', teamName)
  expect(data).toEqual([])
})

test('T-62 RB1 refuses a minor captain and a control character before anything is sent', async ({ actors }) => {
  const event = await freeEvent()
  const page = await setUp(actors.runner, 390)
  await fillCaptain(page, event, { teamName: 'Wilki' })
  await page.locator('#p-birth').fill('2012-01-01')
  await page.getByRole('button', { name: 'Dalej: skład' }).click()
  await expect(page.getByTestId('form-error')).toHaveText('Kapitanem drużyny może być tylko osoba pełnoletnia.')
  await page.locator('#p-birth').fill('1988-03-01')
  await page.locator('#team-name').fill('Wil\u0007ki')
  await page.getByRole('button', { name: 'Dalej: skład' }).click()
  await expect(page.locator('#team-name-error')).toBeVisible()
  await expect(page.getByTestId('team-captain')).toBeVisible()
})

test('T-66 390 px: one member on screen at a time; the list step changes, removes and adds them', async ({ actors }) => {
  const event = await freeEvent()
  const page = await setUp(actors.runner, 390)
  await toSquad(page, event, { teamName: name(), size: 3 })

  // Only the member's step: no list, no other person, no consents.
  const firsts = () => page.locator('input[id$="-first"]').evaluateAll((els) => els.map((e) => e.id))
  expect(await firsts()).toEqual(['p2-first'])
  await expect(page.getByTestId('person-row')).toHaveCount(0)
  await expect(page.locator('#p2-first')).toBeFocused()
  await expect(page.getByLabel('E-mail', { exact: true })).toBeVisible()
  await expect(page.getByTestId('consent-request-note')).toHaveText('Wyślemy prośbę o akceptację regulaminu.')
  await expect(page.getByTestId('members-consent')).toHaveCount(0)

  // A member's error is answered on their own step.
  await page.getByTestId('person-done').click()
  await expect(page.locator('#p2-first-error')).toBeVisible()
  expect(await firsts()).toEqual(['p2-first'])

  await nextMember(page, 'p2', { first: 'Piotr', email: address('piotr') })
  expect(await firsts()).toEqual(['p3-first'])
  await page.getByTestId('squad-link').click()

  await expect(page.getByRole('heading', { name: 'Skład', exact: true })).toBeVisible()
  await expect(page.getByTestId('person-row')).toHaveCount(3)
  await page.getByRole('button', { name: 'Zmień — Piotr Leśny' }).click()
  await expect(page.locator('#p2-first')).toHaveValue('Piotr')
  await page.getByTestId('squad-link').click()

  // An empty member goes at once, one holding anything asks first; never below team_min.
  await page.getByRole('button', { name: /^Usuń — osoba 3/ }).click()
  await expect(page.getByTestId('person-row')).toHaveCount(2)
  await expect(page.getByRole('button', { name: /^Usuń/ })).toHaveCount(0)

  await page.getByTestId('add-person').click()
  expect((await firsts()).length).toBe(1)
  await page.getByTestId('squad-link').click()
  await page.getByRole('button', { name: 'Usuń — Piotr Leśny' }).click()
  await expect(page.getByTestId('remove-confirm')).toHaveText(/^Usunąć tę osobę\?/)
  await page.getByTestId('remove-no').click()
  await expect(page.getByTestId('person-row')).toHaveCount(3)
  await page.getByRole('button', { name: 'Usuń — Piotr Leśny' }).click()
  await page.getByRole('button', { name: 'Tak, usuń — Piotr Leśny' }).click()
  await expect(page.getByTestId('person-row')).toHaveCount(2)
  await noButtonWraps(page)
})

test('T-66 RB1: a smaller size asks before it drops somebody typed in, a larger one keeps them', async ({ actors }) => {
  const event = await freeEvent()
  const page = await setUp(actors.runner, 390)
  await toSquad(page, event, { teamName: name(), size: 3 })
  await nextMember(page, 'p2', { first: 'Piotr', email: address('piotr') })
  await fillCard(page, 'p3', { first: 'Ewa', gender: 'Kobieta', email: address('ewa') })
  await page.getByTestId('person-done').click()
  await page.getByRole('button', { name: '← Drużyna' }).click()

  const size = page.getByTestId('team-size')
  await size.getByRole('button', { name: '2', exact: true }).click()
  await expect(page.getByTestId('remove-confirm')).toContainText('Usunąć z drużyny: Ewa?')
  await page.getByTestId('remove-no').click()
  await expect(size.getByRole('button', { name: '3', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await size.getByRole('button', { name: '4', exact: true }).click()
  await page.getByRole('button', { name: 'Dalej: skład' }).click()
  await page.getByTestId('squad-link').click()
  await expect(page.getByTestId('person-row')).toHaveCount(4)
  await expect(page.getByTestId('person-row').nth(2)).toContainText('Ewa Leśny')
})

test('T-67 leg order on: ↑/↓ set the legs, the captain may run any of them, and the legs are stored', async ({ actors }) => {
  const event = await freeEvent()
  await setLegOrder(event.categoryIds[0])
  const page = await setUp(actors.runner, 390)
  const teamName = name()
  await toSquad(page, event, { teamName, size: 3 })
  await nextMember(page, 'p2', { first: 'Piotr', email: address('piotr') })
  await nextMember(page, 'p3', { first: 'Ewa', gender: 'Kobieta', email: address('ewa') })

  await expect(page.getByRole('heading', { name: 'Skład i kolejność' })).toBeVisible()
  await page.getByRole('button', { name: 'Wyżej — Ewa Leśny' }).click()
  await page.getByRole('button', { name: 'Wyżej — Ewa Leśny' }).click()
  await expect(page.getByRole('button', { name: 'Wyżej — Ewa Leśny' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Niżej — Piotr Leśny' })).toBeDisabled()
  await expect(page.getByTestId('person-row').nth(0)).toContainText('Zmiana 1')
  await expect(page.getByTestId('person-row').nth(0)).toContainText('Ewa Leśny')
  await noButtonWraps(page)

  // The review of 7a: the focus survives a button going disabled, and the new place is announced.
  await page.getByRole('button', { name: 'Niżej — Ewa Leśny' }).click()
  await expect(page.getByRole('button', { name: 'Niżej — Ewa Leśny' })).toBeFocused()
  await expect(page.getByTestId('move-status')).toHaveText('Ewa Leśny: zmiana 2')
  await page.getByRole('button', { name: 'Wyżej — Ewa Leśny' }).click()
  await expect(page.getByRole('button', { name: 'Niżej — Ewa Leśny' })).toBeFocused()
  await expect(page.getByTestId('move-status')).toHaveText('Ewa Leśny: zmiana 1')

  await page.getByTestId('members-consent').check()
  await page.getByRole('button', { name: 'Zapisz drużynę' }).click()
  await expect(page.getByTestId('done')).toBeVisible()

  const { data: team } = await admin().from('teams').select('id').eq('name', teamName).single()
  const { data: rows } = await admin().from('registrations').select('first_name, team_leg').eq('team_id', team.id).order('team_leg')
  expect(rows.map((r) => [r.first_name, r.team_leg])).toEqual([['Ewa', 1], ['Ola', 2], ['Piotr', 3]])
})

test('T-68 a visitor: the code is checked when RB1 is left and never again; „Wróć” and „Dalej” send no second code', async ({ actors }) => {
  const event = await paidEvent()
  const email = address('captain')
  const page = await setUp(actors.viewer, 390)
  await fillCaptain(page, event, { teamName: name(), email })
  await page.getByRole('button', { name: 'Dalej: skład' }).click()
  await expect(page.getByTestId('code-step')).toBeVisible()
  let code = null
  for (let i = 0; i < 40 && !code; i++) { code = await lastCodeFor(email); if (!code) await new Promise((r) => setTimeout(r, 250)) }
  await page.getByLabel('Kod (6 cyfr)').fill(code)
  await page.getByRole('button', { name: 'Dalej' }).click()
  await expect(page.getByTestId('member-card')).toBeVisible()
  const sent = (await messagesTo(email)).length

  await nextMember(page, 'p2', { first: 'Piotr', email: address('piotr') })
  await page.getByRole('button', { name: '← Drużyna' }).click()
  await page.getByRole('button', { name: 'Dalej: skład' }).click()
  await expect(page.getByTestId('squad-list')).toBeVisible()
  await page.getByTestId('members-consent').check()
  await page.getByRole('button', { name: 'Dalej: płatność' }).click()
  await expect(page.getByTestId('checkout')).toBeVisible()
  await expect(page.getByLabel('Kod (6 cyfr)')).toHaveCount(0)
  await page.getByRole('button', { name: '← Wróć' }).click()
  await expect(page.getByTestId('squad-list')).toBeVisible()
  expect((await messagesTo(email)).length).toBe(sent)
})

test('T-68 Back walks the steps with the squad intact, and the page asks before it is closed once RB1 is left', async ({ actors }) => {
  const event = await freeEvent()
  const page = await setUp(actors.runner, 390)
  await page.goto(`/events/${event.slug}`)
  await page.getByTestId('competition').first().click()
  await expect(page.getByTestId('team-captain')).toBeVisible()
  const guarded = () => page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    return e.defaultPrevented
  })
  expect(await guarded()).toBe(false)

  const form = page.url()
  await page.getByLabel('Nazwa drużyny').fill('Wilki')
  await fillCard(page, 'p', { ...CAPTAIN, email: ACTOR_EMAILS.runner })
  await tickAll(page)
  await page.getByRole('button', { name: 'Dalej: skład' }).click()
  await expect(page.getByTestId('member-card')).toBeVisible()
  expect(await guarded()).toBe(true)
  await nextMember(page, 'p2', { first: 'Piotr', email: address('piotr') })
  await expect(page.getByTestId('squad-list')).toBeVisible()

  await page.goBack()
  await expect(page.locator('#p2-first')).toHaveValue('Piotr')
  await page.goBack()
  await expect(page.getByTestId('team-captain')).toBeVisible()
  await expect(page.locator('#team-name')).toHaveValue('Wilki')
  expect(page.url()).toBe(form)
  await page.goForward()
  await expect(page.locator('#p2-first')).toHaveValue('Piotr')
})

test('T-67 leg order off: RB2 reads „Skład”, with no arrows and no legs stored', async ({ actors }) => {
  const event = await freeEvent()
  const page = await setUp(actors.runner, 390)
  const teamName = name()
  await toSquad(page, event, { teamName, size: 2 })
  await nextMember(page, 'p2', { first: 'Piotr', email: address('piotr') })
  await expect(page.getByRole('heading', { name: 'Skład', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Wyżej|Niżej) — / })).toHaveCount(0)
  await expect(page.getByTestId('person-row').nth(1)).toContainText('Osoba 2')
  await noButtonWraps(page)
  await page.getByTestId('members-consent').check()
  await page.getByRole('button', { name: 'Zapisz drużynę' }).click()
  await expect(page.getByTestId('done')).toBeVisible()
  const { data: team } = await admin().from('teams').select('id').eq('name', teamName).single()
  const { data: rows } = await admin().from('registrations').select('team_leg').eq('team_id', team.id)
  expect(rows.map((r) => r.team_leg)).toEqual([null, null])
})

test('T-68 RB1\'s „Skład” validates the captain again: a bad date stays, a changed address asks for the code', async ({ actors }) => {
  const event = await freeEvent()
  const page = await setUp(actors.runner, 390)
  await toSquad(page, event, { teamName: name(), size: 2 })
  await page.getByRole('button', { name: '← Drużyna' }).click()
  await expect(page.getByTestId('team-captain')).toBeVisible()

  await page.locator('#p-birth').fill('2015-01-01')
  await page.getByRole('button', { name: '← Skład' }).click()
  await expect(page.getByTestId('team-captain')).toBeVisible()
  await expect(page.getByTestId('form-error')).toHaveText('Kapitanem drużyny może być tylko osoba pełnoletnia.')

  await page.locator('#p-birth').fill(CAPTAIN.birth)
  await page.locator('#p-email').fill(address('moved'))
  await page.getByRole('button', { name: '← Skład' }).click()
  await expect(page.getByTestId('code-step')).toBeVisible()
})

test('T-68 the leave dialog on a team: Back past the first step asks, „Anuluj” keeps the squad, „OK” leaves', async ({ actors }) => {
  const event = await freeEvent()
  const page = await setUp(actors.runner, 390)
  await toSquad(page, event, { teamName: 'Wilki' })
  const questions = []
  let answer = false
  page.on('dialog', async (d) => {
    questions.push(d.message())
    if (answer) await d.accept()
    else await d.dismiss()
  })
  const back = () => page.evaluate(() => window.history.back())

  await back()
  await expect(page.getByTestId('team-captain')).toBeVisible()
  await back()
  await expect.poll(() => questions.length).toBe(1)
  expect(questions[0]).toBe('Opuścić formularz? Wpisane dane osób przepadną.')
  await expect(page.locator('#team-name')).toHaveValue('Wilki')

  answer = true
  await back()
  await expect.poll(() => questions.length).toBe(2)
  await expect(page.getByTestId('team-captain')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/events/${event.slug}$`))
})
