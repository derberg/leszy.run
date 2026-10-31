import crypto from 'node:crypto'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedFreeEvent, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import { dpayReset, payMock } from '../helpers/dpayControl.js'
import { captureRequests, clearMessages, lastCodeFor, messagesTo } from '../helpers/emailCapture.js'
import { DPAY_MOCK_PORT } from '../helpers/dpayMock.js'
import { startScratchHost } from '../helpers/hostPull.js'

// Plan 4 task 8: a family across every audience at once (G-58 in
// docs/registration/scenario-matrix.md). `runner` pays for themself (NW 9 km), an added adult
// (Piotr, Bieg 9 km) and a child (Bieg dzieci); `viewer` reads the public start list, `owner`
// reads Zgłoszenia, `invitee` is Piotr holding only the link from his e-mail. G-60 (browser half):
// after a payer deletes the account, Zgłoszenia reads „kontakt opiekuna usunięty” under the child
// and „Usunięte konto” once for the payer's own entry. The API half is family-gdpr.test.js.

const ZT = '00000000-0000-4000-8000-0000000000c1'
const NW = { name: 'NW 9 km', discipline: 'nw', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }
const BIEG = { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:30', capacity: 50 }
const KIDS = { name: 'Bieg dzieci 1 km', discipline: 'run', distanceLabel: '1 km', startTime: '09:00', capacity: 50, maxAge: 17, isKids: true }
const PAY_PAGE = new RegExp(`localhost:${DPAY_MOCK_PORT}\\/pay\\/`)
const TOKEN_RE = /\/zgoda#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/
const rand = () => crypto.randomBytes(4).toString('hex')

let owner

test.beforeAll(async () => {
  owner = await sessionFor(ACTOR_EMAILS.owner)
  const status = await callFn('organizer-status', owner, { clubId: ZT })
  if (!status.body.data.agreementAccepted) {
    await callFn('accept-organizer-agreement', owner, { clubId: ZT, version: status.body.data.version })
  }
  await dpayReset()
})
test.beforeEach(async () => { await resetThrottle() })

async function offline(page) {
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  return page
}

/** Fills one card; `prefix` is `p` for card 1, `p2`, `p3`… for the added ones. */
async function fillCard(page, prefix, { first, last, birth, gender = 'Kobieta', email, phone, city }) {
  await page.locator(`#${prefix}-first`).fill(first)
  await page.locator(`#${prefix}-last`).fill(last)
  if (birth) await page.locator(`#${prefix}-birth`).fill(birth)
  await page.locator(`[aria-labelledby="${prefix}-gender-label"]`).getByRole('button', { name: gender, exact: true }).click()
  if (email !== undefined) await page.locator(`#${prefix}-email`).fill(email)
  if (phone !== undefined) await page.locator(`#${prefix}-phone`).fill(phone)
  if (city !== undefined) await page.locator(`#${prefix}-city`).fill(city)
}

/** Warsaw's today minus `years`. */
function birthFor(years) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date())
  const [y, m, d] = today.split('-').map(Number)
  return new Date(Date.UTC(y - years, m - 1, d)).toISOString().slice(0, 10)
}

async function mailsTo(address, n) {
  for (let i = 0; i < 60; i++) {
    const msgs = await messagesTo(address)
    if (msgs.length >= n) return msgs
    await new Promise((r) => setTimeout(r, 250))
  }
  return messagesTo(address)
}

const zgloszenia = (eventId) => `/klub/zatyrani-test/wydarzenia/${eventId}/zgloszenia`

test('G-58 a family across every audience: one payment for three people, one consent e-mail, the public list without the child\'s town, the organizer\'s count, Piotr accepts by the link, the host pulls all three', async ({ actors }) => {
  const name = `Rodzinny Bieg ${rand()}`
  const event = { name, ...(await createPublishedPaidEvent(owner, {
    name, competitions: [NW, BIEG, KIDS], prices: { 'NW 9 km': 6000, 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 2000 },
  })) }
  const [nw, bieg, kids] = event.categoryIds
  const groups = await admin().from('kids_groups').insert([
    { category_id: kids, label: 'Dzieci 2015–2017', birth_year_from: 2015, birth_year_to: 2017, gender: null },
    { category_id: kids, label: 'Dzieci 2018–2020', birth_year_from: 2018, birth_year_to: 2020, gender: null },
  ])
  expect(groups.error).toBeNull()
  const piotr = `piotr-${rand()}@test.local`
  await clearMessages()

  // runner: themself (NW 9 km), Piotr (Bieg 9 km) and Zosia (the kids' run), „Nie tym razem”, paid on the mock.
  const page = await offline(await actors.runner.newPage())
  await page.goto(`/events/${event.slug}/zapis/${nw}`)
  await fillCard(page, 'p', { first: 'Ola', last: 'Leśna', birth: '1988-03-01', email: ACTOR_EMAILS.runner, phone: '600100200', city: 'Leszno' })
  await page.getByTestId('add-person').click()
  await page.locator('#p2-competition').selectOption(bieg)
  await fillCard(page, 'p2', { first: 'Piotr', last: 'Borowy', birth: '1987-01-01', gender: 'Mężczyzna', email: piotr, phone: '600300400', city: 'Leszno' })
  await page.getByTestId('add-person').click()
  await page.locator('#p3-competition').selectOption(kids)
  await fillCard(page, 'p3', { first: 'Zosia', last: 'Leśna', birth: birthFor(9), gender: 'Dziewczynka', city: 'Gierałtowice' })
  await page.getByTestId('person-card').getByTestId('guardian-consent').check()
  await page.getByTestId('person-done').click()
  const boxes = page.getByTestId('consents').getByRole('checkbox')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
  await page.getByTestId('registration-submit').click()

  await expect(page.getByTestId('checkout-line')).toHaveCount(3)
  await expect(page.getByTestId('checkout-amounts')).toContainText('140,00 zł')
  await page.getByRole('button', { name: 'Nie tym razem' }).click()
  await page.getByTestId('pay').click()
  await expect(page).toHaveURL(PAY_PAGE)
  const { data: order } = await admin().from('orders').select('id').eq('event_id', event.eventId).single()
  const { data: attempts } = await admin().from('payment_attempts').select('dpay_transaction_id')
    .eq('order_id', order.id).order('created_at', { ascending: false }).limit(1)
  await payMock(attempts[0].dpay_transaction_id, 'paid')
  await page.goto(`/zamowienie/${order.id}`)
  await expect(page.getByTestId('order-paid')).toBeVisible()
  const person = (who) => page.getByTestId('order-person').filter({ hasText: who })
  await expect(person('Piotr Borowy').getByTestId('consent-tag')).toHaveText('CZEKA NA ZGODĘczeka na zgodę na regulamin')

  // E-mails: one „Opłacone — …” to the payer listing three people, one consent request to Piotr, nothing else.
  const paidMails = (await mailsTo(ACTOR_EMAILS.runner, 1)).filter((m) => m.subject?.startsWith('Opłacone — '))
  expect(paidMails).toHaveLength(1)
  expect(paidMails[0].subject).toBe(`Opłacone — ${name}`)
  const listed = paidMails[0].text.split('\n').filter((l) => l.startsWith('- '))
  expect(listed).toHaveLength(3)
  for (const who of ['Ola Leśna', 'Piotr Borowy', 'Zosia Leśna']) expect(listed.some((l) => l.includes(who)), who).toBe(true)
  const consentMails = await mailsTo(piotr, 1)
  expect(consentMails).toHaveLength(1)
  expect(consentMails[0].subject).toBe(`Zapisano Cię na ${name} — zaakceptuj regulamin`)
  expect((await captureRequests()).map((r) => r.subject).sort())
    .toEqual([`Opłacone — ${name}`, `Zapisano Cię na ${name} — zaakceptuj regulamin`])

  // viewer: the payer and the child, the child with no town; Piotr not by name until he accepts (T7-F2).
  const viewer = await offline(await actors.viewer.newPage())
  await viewer.goto(`/events/${event.slug}/lista`)
  const entries = viewer.getByTestId('start-list-entry')
  await expect(entries).toHaveCount(2)
  await expect(entries.filter({ hasText: 'Ola Leśna' })).toContainText('Leszno')
  await expect(entries.filter({ hasText: 'Zosia Leśna' })).toHaveCount(1)
  await expect(viewer.getByTestId('start-list')).not.toContainText('Gierałtowice')
  await expect(viewer.getByTestId('start-list')).not.toContainText('Borowy')
  const biegCard = viewer.getByTestId('list-competition').filter({ hasText: 'Bieg 9 km' }).filter({ hasNotText: 'dzieci' })
  await expect(biegCard).toContainText('1 / 50 miejsc')
  await expect(biegCard).toContainText('1 opłacone')

  // owner: one consent outstanding.
  const org = await offline(await actors.owner.newPage())
  await org.goto(zgloszenia(event.eventId))
  await expect(org.getByTestId('awaiting-consent')).toContainText('Czeka na zgody: 1')
  const piotrRow = () => org.locator('tr').filter({ hasText: 'Piotr Borowy' })
  await expect(piotrRow().getByTestId('registration-consent')).toHaveText('czeka na zgodę')

  // invitee: the link from the e-mail, the code, every box.
  const token = consentMails[0].text.match(TOKEN_RE)?.[1]
  expect(token).toBeTruthy()
  const zgoda = await offline(await actors.invitee.newPage())
  await zgoda.goto(`/zgoda#${token}`)
  await zgoda.getByRole('button', { name: 'Wyślij kod' }).click()
  let code = null
  for (let i = 0; i < 40 && !code; i++) {
    if ((await messagesTo(piotr)).length >= 2) code = await lastCodeFor(piotr)
    if (!code) await zgoda.waitForTimeout(250)
  }
  expect(code).toMatch(/^\d{6}$/)
  await zgoda.locator('#consent-code').fill(code)
  await zgoda.getByRole('button', { name: 'Dalej' }).click()
  const consentBoxes = zgoda.getByTestId('consents').getByRole('checkbox')
  await expect(consentBoxes).toHaveCount(4)
  for (let i = 0; i < 4; i++) await consentBoxes.nth(i).check()
  await zgoda.getByRole('button', { name: 'Akceptuję regulamin' }).click()
  await expect(zgoda.getByTestId('consent-done')).toContainText('Dziękujemy — regulamin zaakceptowany.')

  // owner reloads: 0 outstanding, Piotr accepted. runner's RA5: ✓ REGULAMIN for Piotr. viewer: three names.
  await org.reload()
  await expect(org.getByTestId('awaiting-consent')).toContainText('Czeka na zgody: 0')
  await expect(piotrRow().getByTestId('registration-consent')).toHaveText('✓ zaakceptowany')
  await page.reload()
  await expect(person('Piotr Borowy').getByTestId('consent-tag')).toHaveText('✓ REGULAMINregulamin zaakceptowany')
  await viewer.reload()
  await expect(entries).toHaveCount(3)
  await expect(entries.filter({ hasText: 'Piotr Borowy' })).toHaveCount(1)

  // The timing host pulls all three; the child has no address.
  const host = await startScratchHost()
  try {
    await host.pull()
    const rows = await host.sql`select first_name, last_name, email from participants where event_id = ${event.eventId} order by first_name`
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { first_name: 'Ola', last_name: 'Leśna', email: ACTOR_EMAILS.runner },
      { first_name: 'Piotr', last_name: 'Borowy', email: piotr },
      { first_name: 'Zosia', last_name: 'Leśna', email: null },
    ])
  } finally {
    await host.stop()
  }
})

test('G-60 (browser) a payer deleted the account: Zgłoszenia reads „kontakt opiekuna usunięty” under the child and „Usunięte konto” once', async ({ actors }) => {
  const event = await createPublishedFreeEvent(owner, {
    competitions: [BIEG, { name: 'Bieg dzieci 1 km', discipline: 'run', distanceLabel: '1 km', startTime: '09:00', capacity: 50 }],
  })
  const [bieg, kids] = event.categoryIds
  const db = admin()
  const payerEmail = `runner-payer-${rand()}@test.local`
  const payer = await sessionFor(payerEmail)
  const { data: consents } = await db.from('event_consents').select('id').eq('event_id', event.eventId)
  const person = (over) => ({ firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-01-01', gender: 'K', phone: '+48500100200', ageGroupLabel: 'K open', ...over })
  const { error } = await db.rpc('register_free', {
    p_people: [
      { ...person({ email: payerEmail }), categoryId: bieg, role: 'self' },
      { ...person({ firstName: 'Zosia', birthDate: '2016-05-05', ageGroupLabel: 'K dzieci' }), categoryId: kids, role: 'minor' },
    ],
    p_profile_id: payer.profileId,
    p_meta: { buyerName: 'Ola Leśna', consentIds: consents.map((c) => c.id), ip: '203.0.113.9', userAgent: 'test' },
  })
  expect(error).toBeNull()
  const sha = crypto.createHash('sha256').update('123456').digest('hex')
  const code = await db.from('auth_codes').insert({
    email: payerEmail, code_hash: sha, purpose: 'delete_account', expires_at: new Date(Date.now() + 600000).toISOString(),
  })
  expect(code.error).toBeNull()
  const deleted = await callFn('delete-my-account', payer, { action: 'confirm', code: '123456' })
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200)

  for (const width of [1440, 390]) {
    const org = await offline(await actors.owner.newPage())
    await org.setViewportSize({ width, height: 900 })
    await org.goto(zgloszenia(event.eventId))
    const scope = width === 390 ? org.getByTestId('registrations-cards') : org.getByTestId('registrations')
    await expect(scope.getByTestId('guardian-removed')).toHaveText('kontakt opiekuna usunięty')
    await expect(scope).toContainText('Zosia Leśna')
    await expect(scope).toContainText('Usunięte konto')
    await expect(scope).not.toContainText('Usunięte konto Usunięte konto')
    await org.close()
  }
})
