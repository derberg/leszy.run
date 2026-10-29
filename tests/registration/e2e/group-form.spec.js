import crypto from 'node:crypto'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedFreeEvent, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import { dpayReset, payMock } from '../helpers/dpayControl.js'
import { messagesTo } from '../helpers/emailCapture.js'
import { DPAY_MOCK_PORT } from '../helpers/dpayMock.js'

// Plan 4 task 5a: the group form (RA2 + RA3) as the runner uses it, on a free and a paid
// event, at 390 and 1440 px: G-44 (a)…(c) in docs/registration/scenario-matrix.md.
// Task 5b: (d), the consent tags and the reminder on RA5, and G-47, RA4 for a group (one line
// per person, re-priced from the server's answer after price_changed).

const ZT = '00000000-0000-4000-8000-0000000000c1'
const BIEG = { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }
const DZIECI = { name: 'Bieg dzieci 1 km', discipline: 'run', distanceLabel: '1 km', startTime: '09:00', capacity: 50 }
const DUPLICATE_TEXT = 'Ten adres e-mail jest już zapisany na te zawody.'
const rand = () => crypto.randomBytes(4).toString('hex')
const email = (tag) => `runner-${tag}-${rand()}@test.local`

let owner

test.beforeAll(async () => {
  owner = await sessionFor(ACTOR_EMAILS.owner)
  const status = await callFn('organizer-status', owner, { clubId: ZT })
  if (!status.body.data.agreementAccepted) {
    await callFn('accept-organizer-agreement', owner, { clubId: ZT, version: status.body.data.version })
  }
  await dpayReset()
})
// The runner registers many groups here: the per-buyer caps (30 people, 5 duplicate answers a day) start empty.
test.beforeEach(async () => { await resetThrottle() })

async function offline(page) {
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  return page
}

const EVENTS = {
  free: (competitions) => createPublishedFreeEvent(owner, { competitions }),
  paid: (competitions) => createPublishedPaidEvent(owner, { competitions, prices: { 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 2000 } }),
}

/** Fills one card; `prefix` is `p` for card 1, `p2`, `p3`… for the added ones. */
async function fillCard(page, prefix, { first, last, birth, gender = 'Kobieta', email: address, phone = '600100200' }) {
  await page.locator(`#${prefix}-first`).fill(first)
  await page.locator(`#${prefix}-last`).fill(last)
  if (birth) await page.locator(`#${prefix}-birth`).fill(birth)
  await page.locator(`[aria-labelledby="${prefix}-gender-label"]`).getByRole('button', { name: gender, exact: true }).click()
  if (address !== undefined) await page.locator(`#${prefix}-email`).fill(address)
  if (phone !== undefined) await page.locator(`#${prefix}-phone`).fill(phone)
}

async function tickAll(page) {
  const boxes = page.getByTestId('consents').getByRole('checkbox')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
}

/** The runner's own card, logged in: the session holds this address, so no code is asked. */
async function fillMe(page) {
  await fillCard(page, 'p', { first: 'Ola', last: 'Leśna', birth: '1988-03-01', email: ACTOR_EMAILS.runner })
}

/** „Dalej” / „Zapisz się”; on a paid event through RA4 („Nie tym razem”, „Zapłać”). */
async function submit(page, mode) {
  await page.getByTestId('registration-submit').click()
  if (mode === 'paid') {
    await expect(page.getByTestId('checkout')).toBeVisible()
    await page.getByRole('button', { name: 'Nie tym razem' }).click()
    await page.getByTestId('pay').click()
  }
}

const competition = (categoryId) => admin().from('competitions').select('taken, capacity').eq('category_id', categoryId).single()
const ordersOf = async (eventId) => (await admin().from('orders').select('id').eq('event_id', eventId)).data
const registrationsOf = async (eventId) => (await admin().from('registrations').select('id, email').eq('event_id', eventId)).data

/** Warsaw's today minus `years`, plus `days`. */
function birthFor(years, days = 0) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date())
  const [y, m, d] = today.split('-').map(Number)
  const t = new Date(Date.UTC(y - years, m - 1, d + days))
  return t.toISOString().slice(0, 10)
}

/** Nothing scrolls sideways, and no button label is cut or wraps. */
async function fitsNarrow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const overflowing = await page.evaluate(() => [...document.querySelectorAll('#main-content button, #main-content a')]
    .filter((el) => el.offsetParent && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1))
    .map((el) => el.textContent.trim()))
  expect(overflowing).toEqual([])
  for (const b of await page.locator('#main-content button:visible').all()) {
    const box = await b.boundingBox()
    if (box) expect(box.height, await b.textContent()).toBeLessThan(60)
  }
}

for (const [mode, width] of [['free', 1440], ['paid', 390]]) {
  test(`G-44 (a) ${mode} ${width} px: person 2 already registered → the error under person 2's e-mail, the other cards kept, nothing taken`, async ({ actors }) => {
    const event = await EVENTS[mode]([BIEG])
    const [c9] = event.categoryIds
    // Person 2 registered last week: through register-free on the free event, as a confirmed row on the paid one.
    const taken = email('taken')
    if (mode === 'free') {
      const r = await callFn('register-free', await sessionFor(taken), {
        categoryId: c9, person: { firstName: 'Piotr', lastName: 'Wcześniej', birthDate: '1987-01-01', gender: 'M', email: taken, phone: '600300400' },
        acceptedConsentIds: (await admin().from('event_consents').select('id').eq('event_id', event.eventId)).data.map((c) => c.id),
        serviceRegulamin: true,
      })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
    } else {
      const { error } = await admin().from('registrations').insert({
        event_id: event.eventId, category_id: c9, status: 'confirmed', first_name: 'Piotr', last_name: 'Wcześniej',
        birth_date: '1987-01-01', gender: 'M', email: taken, phone: '600300400', consent_state: 'accepted', list_price: 6000, price: 6000,
      })
      expect(error).toBeNull()
    }
    const before = (await competition(c9)).data.taken

    const page = await offline(await actors.runner.newPage())
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/events/${event.slug}/zapis/${c9}`)
    await fillMe(page)
    await page.getByTestId('add-person').click()
    await expect(page.getByTestId('person-card')).toHaveCount(1)
    await expect(page.getByTestId('person-card')).toHaveAttribute('data-variant', 'adult')
    await expect(page.getByTestId('consent-request-note')).toHaveText('Ta osoba dostanie e-mail z prośbą o akceptację regulaminu.')
    await fillCard(page, 'p2', { first: 'Piotr', last: 'Wcześniej', birth: '1987-01-01', gender: 'Mężczyzna', email: taken, phone: '600300400' })
    await page.getByTestId('add-person').click()
    await fillCard(page, 'p3', { first: 'Ewa', last: 'Leśna', birth: '1990-06-06', email: email('ewa'), phone: '600500600' })
    await tickAll(page)
    if (width === 390) await fitsNarrow(page)
    await submit(page, mode)

    await expect(page.locator('#p2-email-error')).toHaveText(DUPLICATE_TEXT)
    await expect(page.getByTestId('registration-form')).toBeVisible()
    // I-1: the form says whose data to fix, and the field is where the person is looking.
    await expect(page.getByRole('alert')).toHaveText('Popraw dane: Piotr Wcześniej.')
    await expect(page.locator('#p2-email')).toBeFocused()
    await expect(page.locator('#p2-email')).toBeInViewport()
    await expect(page.locator('#p-first')).toHaveValue('Ola')
    await expect(page.locator('#p-email')).toHaveValue(ACTOR_EMAILS.runner)
    await expect(page.locator('#p3-first')).toHaveValue('Ewa')
    await expect(page.locator('#p2-first')).toHaveValue('Piotr')
    await expect(page.locator('#p-email-error')).toHaveCount(0)
    expect((await competition(c9)).data.taken).toBe(before)
    expect((await registrationsOf(event.eventId)).map((r) => r.email)).toEqual([taken])
    expect(await ordersOf(event.eventId)).toEqual([])
  })
}

for (const [mode, width] of [['free', 390], ['paid', 1440]]) {
  test(`G-44 (b) ${mode} ${width} px: a competition of the group fills after the page loaded → the message names it, nothing created or charged`, async ({ actors }) => {
    const event = await EVENTS[mode]([BIEG, { ...DZIECI, capacity: 5 }])
    const [c9, kids] = event.categoryIds
    const page = await offline(await actors.runner.newPage())
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/events/${event.slug}/zapis/${c9}`)
    await fillMe(page)
    await page.getByTestId('add-person').click()
    await page.locator('#p2-competition').selectOption(kids)
    await fillCard(page, 'p2', { first: 'Zosia', last: 'Leśna', birth: birthFor(9), gender: 'Dziewczynka', phone: undefined })
    const card = page.getByTestId('person-card')
    await expect(card).toHaveAttribute('data-variant', 'minor')
    await expect(page.locator('#p2-email')).toHaveCount(0)
    await expect(page.locator('#p2-phone')).toHaveValue('600100200') // card 1's (D4-26)
    await expect(card.getByTestId('guardian')).toContainText(`Opiekunem jestem ja — Ola Leśna, ${ACTOR_EMAILS.runner}`)
    const guardianBox = card.getByTestId('guardian-consent')
    await expect(guardianBox).not.toBeChecked()
    await tickAll(page)
    await expect(page.getByTestId('registration-submit')).toBeDisabled() // the guardian box is required too
    await guardianBox.check()
    await expect(page.getByTestId('registration-submit')).toBeEnabled()

    // The kids' run fills (the organizer's admin, a group elsewhere) after the page loaded.
    const { error } = await admin().from('competitions').update({ taken: 5 }).eq('category_id', kids)
    expect(error).toBeNull()
    if (width === 390) await fitsNarrow(page)
    await submit(page, mode)

    // The refusal names the competition and lands on the card in it (I-1); from RA4 too (5b).
    await expect(page.getByTestId('registration-form')).toBeVisible()
    await expect(page.getByRole('alert')).toHaveText('Brak wolnych miejsc w konkurencji Bieg dzieci 1 km. Zmień konkurencję: Zosia Leśna.')
    await expect(page.locator('#p2-competition-error')).toHaveText('Brak wolnych miejsc w konkurencji Bieg dzieci 1 km.')
    await expect(page.locator('#p2-competition')).toBeFocused()
    await expect(page.locator('#p2-competition')).toBeInViewport()
    expect((await competition(c9)).data.taken).toBe(0)
    expect((await competition(kids)).data.taken).toBe(5)
    expect(await registrationsOf(event.eventId)).toEqual([])
    expect(await ordersOf(event.eventId)).toEqual([])
  })
}

for (const [mode, width] of [['free', 390], ['paid', 1440]]) {
  test(`G-44 (c) ${mode} ${width} px: the 10th person ends „+ Zapisz kolejną osobę”; one day short of 18 is a child's card`, async ({ actors }) => {
    const event = await EVENTS[mode]([BIEG])
    const [c9] = event.categoryIds
    const page = await offline(await actors.runner.newPage())
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/events/${event.slug}/zapis/${c9}`)
    const add = page.getByTestId('add-person')
    await expect(add).toHaveText('+ Zapisz kolejną osobę')

    // M-2: „Nie startuję” alone opens card 2 with the focus on it; off again, the empty card goes.
    await page.getByTestId('not-running').check()
    await expect(page.locator('#p2-first')).toBeFocused()
    await page.getByTestId('not-running').uncheck()
    await expect(page.getByTestId('person-card')).toHaveCount(0)
    // M-6: „Usuń” on a card with data asks first, in the page.
    await add.click()
    await page.locator('#p2-first').fill('Zosia')
    await page.getByRole('button', { name: 'Usuń — Zosia' }).click()
    await expect(page.getByTestId('remove-confirm')).toContainText('Usunąć Zosia?')
    await page.getByTestId('remove-no').click()
    await expect(page.locator('#p2-first')).toHaveValue('Zosia')
    await page.getByRole('button', { name: 'Usuń — Zosia' }).click()
    await page.getByTestId('remove-yes').click()
    await expect(page.getByTestId('person-card')).toHaveCount(0)

    for (let i = 0; i < 9; i++) await add.click()
    await expect(page.getByTestId('person-card')).toHaveCount(9)
    await expect(add).toBeDisabled()
    await expect(page.getByTestId('fold-card').first()).toHaveText('Dodaj · 10 osób')

    const second = page.getByTestId('person-card').first()
    await page.locator('#p2-birth').fill(birthFor(18, 1))
    await expect(second).toHaveAttribute('data-variant', 'minor')
    await expect(page.locator('#p2-email')).toHaveCount(0)
    await expect(second.locator('[aria-labelledby="p2-gender-label"]').getByRole('button')).toHaveText(['Dziewczynka', 'Chłopiec'])
    await expect(second.getByTestId('category-preview')).toContainText('Grupa')
    await expect(second.getByTestId('guardian-consent')).not.toBeChecked()
    await expect(second.getByTestId('next-child')).toHaveText('+ Kolejne dziecko')
    await page.locator('#p2-birth').fill(birthFor(18))
    await expect(second).toHaveAttribute('data-variant', 'adult')
    await expect(page.locator('#p2-email')).toBeVisible()

    // „Nie startuję” makes card 1 the payer only: imię, nazwisko, e-mail (and the phone the children take).
    await page.getByTestId('not-running').check()
    await expect(page.locator('#p-birth')).toHaveCount(0)
    await expect(page.locator('#p-email')).toBeVisible()
    await expect(add).toBeEnabled() // 9 people now
    if (width === 390) await fitsNarrow(page)

    // M-1: the back link asks before it drops the group; declined, the form stays.
    let asked = null
    page.once('dialog', (d) => { asked = d.message(); d.dismiss() })
    await page.getByRole('link', { name: '← Konkurencje' }).click()
    await expect.poll(() => asked).toBe('Opuścić formularz? Wpisane dane osób przepadną.')
    await expect(page.getByTestId('registration-form')).toBeVisible()
    await expect(page.getByTestId('person-card')).toHaveCount(9)
  })
}

const PAY_PAGE = new RegExp(`localhost:${DPAY_MOCK_PORT}\\/pay\\/`)

/** The newest dpay transaction of the event's one order. */
async function orderAndTxn(eventId) {
  const orders = await ordersOf(eventId)
  expect(orders).toHaveLength(1)
  const { data } = await admin().from('payment_attempts').select('dpay_transaction_id, created_at')
    .eq('order_id', orders[0].id).order('created_at', { ascending: false }).limit(1)
  return { orderId: orders[0].id, txnId: data[0].dpay_transaction_id }
}

async function mailsTo(address, n) {
  for (let i = 0; i < 60; i++) {
    const msgs = await messagesTo(address)
    if (msgs.length >= n) return msgs
    await new Promise((r) => setTimeout(r, 250))
  }
  return messagesTo(address)
}

/** Ola (the runner), Piotr (an added adult) and Zosia (a child in the kids' run), all ticked. */
async function fillFamily(page, kids, partner) {
  await fillMe(page)
  await page.getByTestId('add-person').click()
  await fillCard(page, 'p2', { first: 'Piotr', last: 'Leśny', birth: '1987-01-01', gender: 'Mężczyzna', email: partner, phone: '600300400' })
  await page.getByTestId('fold-card').click()
  await page.getByTestId('add-person').click()
  await page.locator('#p3-competition').selectOption(kids)
  await fillCard(page, 'p3', { first: 'Zosia', last: 'Leśna', birth: birthFor(9), gender: 'Dziewczynka', phone: undefined })
  await page.getByTestId('person-card').getByTestId('guardian-consent').check()
  await tickAll(page)
}

const KIDS = { ...DZIECI, maxAge: 17, isKids: true }
async function kidsGroups(kids) {
  const { error } = await admin().from('kids_groups').insert([
    { category_id: kids, label: 'Dzieci 2015–2017', birth_year_from: 2015, birth_year_to: 2017, gender: null },
    { category_id: kids, label: 'Dzieci 2018–2020', birth_year_from: 2018, birth_year_to: 2020, gender: null },
  ])
  expect(error).toBeNull()
}

for (const [mode, width] of [['free', 390], ['free', 1440], ['paid', 390], ['paid', 1440]]) {
  test(`G-44 (d) ${mode} ${width} px: RA5 tags the others; „Wyślij przypomnienie →” in Piotr's row sends one more consent e-mail`, async ({ actors }) => {
    const event = await EVENTS[mode]([BIEG, KIDS])
    const [c9, kids] = event.categoryIds
    await kidsGroups(kids)
    const partner = email('partner')
    const page = await offline(await actors.runner.newPage())
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/events/${event.slug}/zapis/${c9}`)
    await fillFamily(page, kids, partner)
    await page.getByTestId('registration-submit').click()

    let person
    if (mode === 'free') {
      await expect(page).toHaveURL(new RegExp(`/events/${event.slug}/zapisano$`))
      await expect(page.getByTestId('done')).toBeVisible()
      person = (name) => page.getByTestId('done-person').filter({ hasText: name })
    } else {
      await expect(page.getByTestId('checkout-line')).toHaveCount(3)
      await page.getByRole('button', { name: 'Nie tym razem' }).click()
      await page.getByTestId('pay').click()
      await expect(page).toHaveURL(PAY_PAGE)
      const { orderId, txnId } = await orderAndTxn(event.eventId)
      await payMock(txnId, 'paid')
      await page.goto(`/zamowienie/${orderId}`)
      await expect(page.getByTestId('order-paid')).toBeVisible()
      person = (name) => page.getByTestId('order-person').filter({ hasText: name })
    }

    // Every person of the group carries a tag, the payer's own row too (RB4), with a spoken meaning (N-5).
    await expect(person('Ola Leśna').getByTestId('consent-tag')).toHaveText('✓ REGULAMINregulamin zaakceptowany')
    await expect(person('Piotr Leśny').getByTestId('consent-tag')).toHaveText('CZEKA NA ZGODĘczeka na zgodę na regulamin')
    await expect(person('Zosia Leśna').getByTestId('consent-tag')).toHaveText('✓ OPIEKUNzgoda opiekuna')
    // The child is shown by her kids' group, as the form showed her (ruling).
    await expect(person('Zosia Leśna')).toContainText('Dzieci 2015–2017')
    // Only the adult who has not accepted can be reminded, from inside their row.
    await expect(page.getByTestId('remind-consent')).toHaveCount(1)
    const remind = person('Piotr Leśny').getByRole('button', { name: 'Wyślij przypomnienie do: Piotr Leśny' })
    await expect(remind).toHaveText('Wyślij przypomnienie →')
    await expect(person('Piotr Leśny').getByTestId('remind-status')).toHaveAttribute('aria-live', 'polite')
    if (width === 390) await fitsNarrow(page)

    // The consent request went out with the registration (free) or the payment (paid).
    expect(await mailsTo(partner, 1)).toHaveLength(1)
    await remind.click()
    await expect(person('Piotr Leśny').getByTestId('remind-status')).toHaveText('Przypomnienie wysłane.')
    // M-2: one send per page: a second click would spend a slot and kill the link just sent.
    await expect(remind).toBeDisabled()
    const mails = await mailsTo(partner, 2)
    expect(mails).toHaveLength(2)
    expect(mails[1].subject).toMatch(/^Przypomnienie: /)
    // Neither the consent request nor the reminder goes to the payer.
    expect((await messagesTo(ACTOR_EMAILS.runner)).filter((x) => /^Przypomnienie:|regulamin/i.test(x.subject ?? ''))).toEqual([])
  })
}

test('G-47 RA4 390 px: one line per person at its own price; the price moves → every line re-priced from the server, then the payment goes through', async ({ actors }) => {
  const event = await EVENTS.paid([BIEG, DZIECI])
  const [c9, kids] = event.categoryIds
  const page = await offline(await actors.runner.newPage())
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto(`/events/${event.slug}/zapis/${c9}`)
  await fillFamily(page, kids, email('partner'))
  await page.getByTestId('registration-submit').click()

  const lines = page.getByTestId('checkout-line')
  await expect(lines).toHaveCount(3)
  await expect(lines.nth(0)).toContainText('Ola Leśna')
  await expect(lines.nth(0)).toContainText('60,00 zł')
  await expect(lines.nth(1)).toContainText('Piotr Leśny')
  await expect(lines.nth(1)).toContainText('60,00 zł')
  await expect(lines.nth(2)).toContainText('Zosia Leśna')
  await expect(lines.nth(2)).toContainText('Bieg dzieci 1 km')
  await expect(lines.nth(2)).toContainText('20,00 zł')
  await expect(page.getByTestId('checkout-amounts')).toContainText('140,00 zł')
  await page.getByRole('button', { name: 'Nie tym razem' }).click()
  await fitsNarrow(page)

  // The organizer raises the 9 km price while RA4 is open.
  const { error } = await admin().from('competition_prices').update({ amount: 6500 }).eq('category_id', c9).eq('tier_id', event.tierId)
  expect(error).toBeNull()
  await page.getByTestId('pay').click()
  await expect(page.getByRole('alert')).toHaveText('Cena się zmieniła. Sprawdź podsumowanie.')
  await expect(lines.nth(0)).toContainText('65,00 zł')
  await expect(lines.nth(1)).toContainText('65,00 zł')
  await expect(lines.nth(2)).toContainText('20,00 zł')
  await expect(page.getByTestId('checkout-amounts')).toContainText('150,00 zł')
  expect(await ordersOf(event.eventId)).toEqual([])

  await page.getByTestId('pay').click()
  await expect(page).toHaveURL(PAY_PAGE)
  const { data: order } = await admin().from('orders').select('entry_total').eq('event_id', event.eventId).single()
  expect(order.entry_total).toBe(15000)
})

test('G-47 RA5 1440 px: the reminder\'s refusals read in Polish; a 409 reads the people again', async ({ actors }) => {
  const event = await EVENTS.free([BIEG, DZIECI])
  const [c9, kids] = event.categoryIds
  const page = await offline(await actors.runner.newPage())
  await page.goto(`/events/${event.slug}/zapis/${c9}`)
  await fillFamily(page, kids, email('partner'))
  await page.getByTestId('registration-submit').click()
  await expect(page.getByTestId('done')).toBeVisible()
  const row = page.getByTestId('done-person').filter({ hasText: 'Piotr Leśny' })

  const cases = [
    [429, { error: 'Przypomnienie zostało już wysłane. Spróbuj jutro.', code: 'throttled' }, 'Przypomnienie zostało już wysłane. Spróbuj jutro.'],
    [502, { error: 'Nie udało się wysłać przypomnienia. Spróbuj ponownie później.', code: 'email_failed' }, 'Nie udało się wysłać przypomnienia. Spróbuj ponownie później.'],
    [401, { error: 'Authorization required' }, 'Zaloguj się ponownie, żeby wysłać przypomnienie.'],
    [500, { error: 'Internal server error' }, 'Nie udało się wysłać przypomnienia. Spróbuj ponownie później.'],
    [409, { error: 'To zgłoszenie nie czeka na akceptację regulaminu.', code: 'not_awaiting' }, 'To zgłoszenie nie czeka na akceptację regulaminu.'],
  ]
  for (const [status, body, shown] of cases) {
    await page.unroute('**/remind-consent')
    await page.route('**/remind-consent', (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }))
    let reads = 0
    const count = (req) => { if (req.url().endsWith('/my-event-registrations')) reads += 1 }
    page.on('request', count)
    await row.getByTestId('remind-consent').click()
    await expect(row.getByTestId('remind-error')).toHaveText(shown)
    await expect(row.getByTestId('remind-consent')).toBeEnabled()
    if (status === 409) await expect.poll(() => reads).toBe(1)
    else expect(reads).toBe(0)
    page.off('request', count)
  }
})

test('G-47 RA4 1440 px (I-1): a single paid runner whose competition fills stays on RA4 with Plan 3\'s message', async ({ actors }) => {
  const event = await EVENTS.paid([BIEG])
  const [c9] = event.categoryIds
  const page = await offline(await actors.runner.newPage())
  await page.goto(`/events/${event.slug}/zapis/${c9}`)
  await fillMe(page)
  await tickAll(page)
  await page.getByTestId('registration-submit').click()
  await expect(page.getByTestId('checkout')).toBeVisible()
  const { error } = await admin().from('competitions').update({ capacity: 1, taken: 1 }).eq('category_id', c9)
  expect(error).toBeNull()
  await page.getByRole('button', { name: 'Nie tym razem' }).click()
  await page.getByTestId('pay').click()
  await expect(page.getByRole('alert')).toHaveText('Brak wolnych miejsc w tej konkurencji.')
  await expect(page.getByTestId('checkout')).toBeVisible()
  await expect(page.getByTestId('registration-form')).toHaveCount(0)
  expect(await ordersOf(event.eventId)).toEqual([])
})
