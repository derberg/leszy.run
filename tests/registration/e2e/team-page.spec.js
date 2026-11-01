import crypto from 'node:crypto'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedFreeEvent, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import { dpayReset, dpayTransactions, payMock } from '../helpers/dpayControl.js'
import { messagesTo } from '../helpers/emailCapture.js'

// Plan 5 task 7b: RB4, the captain's team page: T-64 and T-65 in docs/registration/scenario-matrix.md.

const ZT = '00000000-0000-4000-8000-0000000000c1'
const STAFETA = (over = {}) => ({
  name: 'Sztafeta', discipline: 'run', distanceLabel: '4 x 5 km', startTime: '10:00', capacity: 20, kind: 'team', teamMin: 2, teamMax: 5, ...over,
})
const CLOSED = 'Zapisy są zamknięte — skład zmienisz w biurze zawodów.'
const TOKEN = /\/zgoda#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/
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

async function team(event, members, { legs = false, displayedTotal = 0 } = {}) {
  const { data: consents } = await admin().from('event_consents').select('id').eq('event_id', event.eventId)
  const all = [{ person: person({ firstName: 'Ola', lastName: 'Leśna', birthDate: '1988-03-01', gender: 'K', email: ACTOR_EMAILS.runner }) }, ...members]
  const r = await callFn('register-team', captain, {
    categoryId: event.categoryIds[0], teamName: `Wilcze Stado ${rand()}`,
    members: legs ? all.map((m, i) => ({ ...m, leg: i + 1 })) : all,
    membersConsent: true, acceptedConsentIds: consents.map((c) => c.id), serviceRegulamin: true, displayedTotal,
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.data
}

async function freeEvent(legs = false, over) {
  const event = await createPublishedFreeEvent(owner, { competitions: [STAFETA(over)] })
  if (legs) {
    const { error } = await admin().from('competitions').update({ leg_order_enabled: true }).eq('category_id', event.categoryIds[0])
    if (error) throw error
  }
  return event
}

async function open(context, event, teamId, width) {
  const page = await context.newPage()
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`/events/${event.slug}/druzyna/${teamId}`)
  return page
}

async function fillMember(page, { first, last = 'Nowa', birth = '1990-01-01', gender = 'Kobieta', email, phone = '600900100' }) {
  await page.locator('#m-first').fill(first)
  await page.locator('#m-last').fill(last)
  await page.locator('#m-birth').fill(birth)
  await page.locator('[aria-labelledby="m-gender-label"]').getByRole('button', { name: gender, exact: true }).click()
  if (email !== undefined) await page.locator('#m-email').fill(email)
  await page.locator('#m-phone').fill(phone)
}

async function noButtonWraps(page) {
  const wrapped = await page.locator('button:visible, a[data-action]:visible').evaluateAll((els) => els
    .filter((e) => e.getClientRects().length > 1 || e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().height > 60)
    .map((e) => e.textContent))
  expect(wrapped).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

async function mails(email, n) {
  for (let i = 0; i < 40; i++) {
    const m = await messagesTo(email)
    if (m.length >= n) return m
    await new Promise((r) => setTimeout(r, 250))
  }
  return messagesTo(email)
}

const rows = (page) => page.getByTestId('team-member')

for (const width of WIDTHS) {
  test(`T-64 ${width} px: reorder, then swap Piotr: the list updates, the adult out and the adult in each get their e-mail, and „Dodaj 5. osobę” goes at the maximum`, async ({ actors }) => {
    const piotr = address('piotr')
    const event = await freeEvent(true)
    const { teamId } = await team(event, [
      { person: person({ firstName: 'Piotr', email: piotr }) }, { person: person({ firstName: 'Ewa', gender: 'K', email: address('ewa') }) },
      { person: person({ firstName: 'Jan', email: address('jan') }) },
    ], { legs: true })
    await mails(piotr, 1)
    const page = await open(actors.runner, event, teamId, width)

    await expect(page.getByTestId('team-page')).toContainText('KAPITAN')
    await expect(page.getByTestId('team-status')).toHaveText('ZAPISANA')
    await expect(page.getByRole('heading', { name: 'Skład · kolejność zmian' })).toBeVisible()
    await expect(page.getByText(/^Zmiany do \d{1,2}\.\d{2}$/)).toBeVisible()
    await expect(rows(page)).toHaveCount(4)
    await expect(rows(page).nth(0).getByTestId('consent-tag')).toContainText('✓ REGULAMIN')
    await expect(rows(page).nth(1).getByTestId('consent-tag')).toContainText('CZEKA NA ZGODĘ')
    await noButtonWraps(page)

    // The order.
    await page.getByRole('button', { name: 'Zmień kolejność zmian' }).click()
    await expect(page.getByTestId('squad-order')).toBeVisible()
    await page.getByRole('button', { name: 'Wyżej — Piotr Leśny' }).click()
    await expect(page.getByRole('button', { name: 'Niżej — Piotr Leśny' })).toBeFocused()
    await expect(page.getByTestId('move-status')).toHaveText('Piotr Leśny: zmiana 1')
    await noButtonWraps(page)
    await page.getByRole('button', { name: 'Zapisz kolejność' }).click()
    await expect(rows(page).nth(0)).toContainText('Piotr Leśny')
    await expect(rows(page).nth(0)).toContainText('ZMIANA 1')
    await expect(rows(page).nth(1)).toContainText('Ola Leśna')
    expect(await messagesTo(piotr)).toHaveLength(1)

    // The swap, one form on screen, the removal confirmed in place.
    await page.getByRole('button', { name: 'Wymień zawodnika' }).click()
    await expect(page.getByRole('button', { name: 'Wymień — Ola Leśna' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Wymień — Piotr Leśny' }).click()
    await expect(page.locator('#m-first')).toBeFocused()
    await expect(rows(page)).toHaveCount(0)
    const anna = address('anna')
    await fillMember(page, { first: 'Anna', email: anna })
    await noButtonWraps(page)
    await page.getByRole('button', { name: 'Wymień zawodnika' }).click()
    await page.getByTestId('remove-no').click()
    await expect(page.locator('#m-first')).toHaveValue('Anna')
    await page.getByRole('button', { name: 'Wymień zawodnika' }).click()
    await expect(page.getByTestId('remove-confirm')).toHaveText(/^Usunąć tę osobę\?/)
    await page.getByTestId('remove-yes').click()
    await expect(rows(page).nth(0)).toContainText('Anna Nowa')
    await expect(page.getByText('Piotr Leśny')).toHaveCount(0)
    expect((await mails(anna, 1)).filter((m) => TOKEN.test(m.text))).toHaveLength(1)
    const out = await mails(piotr, 2)
    expect(out.at(-1).subject).toContain('Nie jesteś już w składzie drużyny')

    // The fifth person, then the maximum.
    await page.getByRole('button', { name: 'Dodaj 5. osobę' }).click()
    await fillMember(page, { first: 'Iga', email: address('iga') })
    await page.getByRole('button', { name: 'Dodaj 5. osobę' }).click()
    await expect(rows(page)).toHaveCount(5)
    await expect(page.getByRole('button', { name: /Dodaj \d\. osobę/ })).toHaveCount(0)
    await noButtonWraps(page)
  })
}

test('T-64 „Wyślij przypomnienie →”: one consent e-mail; once sent the control is off, and after a reload a second click rotates the token', async ({ actors }) => {
  const piotr = address('piotr')
  const event = await freeEvent()
  const { teamId } = await team(event, [{ person: person({ firstName: 'Piotr', email: piotr }) }])
  const [asked] = await mails(piotr, 1)
  const first = TOKEN.exec(asked.text)[1]
  const page = await open(actors.runner, event, teamId, 390)

  await expect(page.getByRole('heading', { name: 'Skład', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Zmień kolejność zmian' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Wyślij przypomnienie do: Ola Leśna' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Wyślij przypomnienie do: Piotr Leśny' }).click()
  await expect(page.getByTestId('remind-status')).toHaveText('Przypomnienie wysłane.')
  await expect(page.getByRole('button', { name: 'Wyślij przypomnienie do: Piotr Leśny' })).toBeDisabled()
  const reminded = await mails(piotr, 2)
  expect(reminded).toHaveLength(2)
  const second = TOKEN.exec(reminded[1].text)[1]
  expect(second).not.toBe(first)
  expect((await callFn('consent-request', null, { token: first })).status).toBe(410)

  await page.reload()
  await page.getByRole('button', { name: 'Wyślij przypomnienie do: Piotr Leśny' }).click()
  await expect(page.getByTestId('remind-status')).toHaveText('Przypomnienie wysłane.')
  const third = TOKEN.exec((await mails(piotr, 3))[2].text)[1]
  expect((await callFn('consent-request', null, { token: second })).status).toBe(410)
  expect((await callFn('consent-request', null, { token: third })).status).toBe(200)
})

test('T-64 a child added: the form asks for the guardian\'s box and the event\'s consents, and they reach the server', async ({ actors }) => {
  const event = await freeEvent()
  const { teamId } = await team(event, [{ person: person({ firstName: 'Piotr', email: address('piotr') }) }])
  const page = await open(actors.runner, event, teamId, 390)

  await page.getByRole('button', { name: 'Dodaj 3. osobę' }).click()
  await expect(page.getByTestId('consents')).toHaveCount(0)
  await fillMember(page, { first: 'Zosia', last: 'Leśna', birth: '2014-05-05', gender: 'Dziewczynka', email: undefined })
  await expect(page.locator('#m-email')).toHaveCount(0)
  await expect(page.getByTestId('guardian')).toContainText(ACTOR_EMAILS.runner)
  const submit = page.getByRole('button', { name: 'Dodaj 3. osobę' })
  await expect(page.getByTestId('consents')).toBeVisible()
  await expect(submit).toBeDisabled()
  const boxes = page.getByTestId('consents').getByRole('checkbox')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
  await submit.click()
  await expect(page.locator('#m-guardian-error')).toBeVisible()
  await page.getByTestId('guardian-consent').check()
  await submit.click()
  await expect(rows(page).nth(2)).toContainText('Zosia Leśna')
  await expect(rows(page).nth(2).getByTestId('consent-tag')).toContainText('✓ OPIEKUN')
  await expect(rows(page).nth(2)).toContainText('12 LAT')
  await expect(page.getByRole('button', { name: 'Wyślij przypomnienie do: Zosia Leśna' })).toHaveCount(0)
})

test('T-64 7b review: a reminder already sent stays off across the page\'s views, and the live region outlives them', async ({ actors }) => {
  const event = await freeEvent()
  const piotr = address('piotr')
  const { teamId } = await team(event, [{ person: person({ firstName: 'Piotr', email: piotr }) }])
  await mails(piotr, 1)
  const page = await open(actors.runner, event, teamId, 390)
  const remind = page.getByRole('button', { name: 'Wyślij przypomnienie do: Piotr Leśny' })
  await expect(remind).toHaveText('Wyślij przypomnienie →')
  await remind.click()
  await expect(remind).toBeDisabled()
  await mails(piotr, 2)

  await page.getByRole('button', { name: 'Wymień zawodnika' }).click()
  await expect(page.getByRole('heading', { name: 'Kogo wymieniasz?' })).toBeVisible()
  await expect(page.getByTestId('team-live')).toHaveCount(1)
  await page.goBack()
  await expect(remind).toBeDisabled()
  expect(await messagesTo(piotr)).toHaveLength(2)

  await page.getByRole('button', { name: 'Dodaj 3. osobę' }).click()
  await expect(page.getByTestId('team-live')).toHaveText('')
  await fillMember(page, { first: 'Anna', email: address('anna') })
  await page.getByRole('button', { name: 'Dodaj 3. osobę' }).click()
  await expect(rows(page)).toHaveCount(3)
  await expect(page.getByTestId('team-live')).toHaveText('Skład zmieniony.')
  await expect(remind).toBeDisabled()
})

test('T-64 7b review: a consent added while a child\'s form is open: the boxes come back, unticked, with the new one, and the add then succeeds', async ({ actors }) => {
  const event = await freeEvent()
  const { teamId } = await team(event, [{ person: person({ firstName: 'Piotr', email: address('piotr') }) }])
  const page = await open(actors.runner, event, teamId, 390)
  await page.getByRole('button', { name: 'Dodaj 3. osobę' }).click()
  await fillMember(page, { first: 'Zosia', last: 'Leśna', birth: '2014-05-05', gender: 'Dziewczynka', email: undefined })
  const boxes = page.getByTestId('consents').getByRole('checkbox')
  const before = await boxes.count()
  for (let i = 0; i < before; i++) await boxes.nth(i).check()
  await page.getByTestId('guardian-consent').check()

  const { error } = await admin().from('event_consents').insert({ event_id: event.eventId, kind: 'custom', text: 'Nowa zgoda organizatora', sort_order: 99 })
  if (error) throw error
  const submit = page.getByRole('button', { name: 'Dodaj 3. osobę' })
  await submit.click()
  await expect(page.getByTestId('form-error')).toHaveText('Zaznacz wymagane zgody.')
  await expect(boxes).toHaveCount(before + 1)
  for (let i = 0; i < before + 1; i++) await expect(boxes.nth(i)).not.toBeChecked()
  await expect(submit).toBeDisabled()
  await expect(page.locator('#m-first')).toHaveValue('Zosia')

  for (let i = 0; i < before + 1; i++) await boxes.nth(i).check()
  await submit.click()
  await expect(rows(page)).toHaveCount(3)
})

test('T-64 7b review: swapping a deleted account\'s entry never reads „Usunąć Usunięte konto?”', async ({ actors }) => {
  const event = await freeEvent()
  const { teamId } = await team(event, [{ person: person({ firstName: 'Piotr', email: address('piotr') }) }])
  const { error } = await admin().from('registrations').update({ first_name: 'Usunięte konto', last_name: 'Usunięte konto' })
    .eq('team_id', teamId).eq('first_name', 'Piotr')
  if (error) throw error
  const page = await open(actors.runner, event, teamId, 390)
  await page.getByRole('button', { name: 'Wymień zawodnika' }).click()
  await page.getByRole('button', { name: 'Wymień — Usunięte konto' }).click()
  await fillMember(page, { first: 'Anna', email: address('anna') })
  await page.getByRole('button', { name: 'Wymień zawodnika' }).click()
  await expect(page.getByTestId('remove-confirm')).toHaveText(/^Usunąć tę osobę\?/)
})

test('T-64 7b review: „Zmiany do …” is a caption, not a heading; a pending team past close has no „Zapłać”', async ({ actors }) => {
  const event = await createPublishedPaidEvent(owner, { competitions: [STAFETA()], prices: { Sztafeta: 24000 } })
  const { teamId, orderId } = await team(event, [{ person: person({ firstName: 'Piotr', email: address('piotr') }) }], { displayedTotal: 24000 })
  const page = await open(actors.runner, event, teamId, 390)
  await expect(page.getByText(/^Zmiany do/)).toBeVisible()
  await expect(page.getByRole('heading', { name: /^Zmiany do/ })).toHaveCount(0)

  const { error } = await admin().from('registration_settings')
    .update({ closes_at: new Date(Date.now() - 60_000).toISOString() }).eq('event_id', event.eventId)
  if (error) throw error
  await page.reload()
  await expect(page.getByTestId('team-status')).toHaveText('CZEKA NA WPŁATĘ')
  await expect(page.getByRole('link', { name: 'Zapłać' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Anuluj zgłoszenie' })).toHaveAttribute('href', `/zamowienie/${orderId}`)
})

test('T-64 a member already registered: the error under the form\'s e-mail, nothing changed, and the leave guard is on while it holds data', async ({ actors }) => {
  const taken = address('taken')
  const event = await freeEvent()
  const { teamId } = await team(event, [{ person: person({ firstName: 'Piotr', email: taken }) }])
  const page = await open(actors.runner, event, teamId, 390)
  const guarded = () => page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    return e.defaultPrevented
  })
  await page.getByRole('button', { name: 'Dodaj 3. osobę' }).click()
  await expect(page.locator('#m-first')).toBeVisible()
  expect(await guarded()).toBe(false)
  await fillMember(page, { first: 'Anna', email: taken })
  expect(await guarded()).toBe(true)
  await page.getByRole('button', { name: 'Dodaj 3. osobę' }).click()
  await expect(page.locator('#m-email-error')).toBeVisible()
  await expect(page.locator('#m-email')).toBeFocused()
  await expect(page.locator('#m-first')).toHaveValue('Anna')

  await page.goBack()
  await expect(rows(page)).toHaveCount(2)
  await page.goForward()
  await expect(page.locator('#m-first')).toHaveValue('Anna')
})

test('T-64 a pending team reads CZEKA NA WPŁATĘ, links to its order and offers no reminder; paid, OPŁACONA', async ({ actors }) => {
  const event = await createPublishedPaidEvent(owner, { competitions: [STAFETA()], prices: { Sztafeta: 24000 } })
  const { teamId, orderId } = await team(event, [{ person: person({ firstName: 'Piotr', email: address('piotr') }) }], { displayedTotal: 24000 })
  const page = await open(actors.runner, event, teamId, 390)

  await expect(page.getByTestId('team-status')).toHaveText('CZEKA NA WPŁATĘ')
  await expect(page.getByRole('link', { name: 'Zapłać' })).toHaveAttribute('href', `/zamowienie/${orderId}`)
  await expect(page.getByRole('link', { name: 'Anuluj zgłoszenie' })).toHaveAttribute('href', `/zamowienie/${orderId}`)
  await expect(page.getByRole('button', { name: 'Wyślij przypomnienie do: Piotr Leśny' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Wymień zawodnika' })).toBeVisible()
  await noButtonWraps(page)

  await payMock((await dpayTransactions()).at(-1).id, 'paid')
  await expect(async () => {
    await page.reload()
    await expect(page.getByTestId('team-status')).toHaveText('OPŁACONA', { timeout: 1000 })
  }).toPass({ timeout: 15000 })
  await expect(page.getByRole('link', { name: 'Zapłać' })).toHaveCount(0)
})

test('T-64 no session → login, back to this page; somebody else → not found', async ({ actors }) => {
  const event = await freeEvent()
  const { teamId } = await team(event, [{ person: person({ firstName: 'Piotr', email: address('piotr') }) }])
  const path = `/events/${event.slug}/druzyna/${teamId}`
  const anon = await open(actors.viewer, event, teamId, 390)
  await expect(anon).toHaveURL(new RegExp(`/login\\?from=${encodeURIComponent(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  const stranger = await open(actors.member, event, teamId, 390)
  await expect(stranger.getByTestId('team-missing')).toBeVisible()
})

for (const width of WIDTHS) {
  test(`T-65 ${width} px: closes_at passes while the page is open: an action answers the closed message and the page swaps to the closed state`, async ({ actors }) => {
    const event = await freeEvent(true)
    const { teamId } = await team(event, [
      { person: person({ firstName: 'Piotr', email: address('piotr') }) }, { person: person({ firstName: 'Ewa', gender: 'K', email: address('ewa') }) },
    ], { legs: true })
    const page = await open(actors.runner, event, teamId, width)
    await expect(page.getByRole('button', { name: 'Zmień kolejność zmian' })).toBeVisible()
    await noButtonWraps(page)

    await page.getByRole('button', { name: 'Zmień kolejność zmian' }).click()
    await page.getByRole('button', { name: 'Niżej — Ola Leśna' }).click()
    const { error } = await admin().from('registration_settings')
      .update({ closes_at: new Date(Date.now() - 60_000).toISOString() }).eq('event_id', event.eventId)
    if (error) throw error
    await page.getByRole('button', { name: 'Zapisz kolejność' }).click()

    await expect(page.getByTestId('team-closed')).toHaveText(CLOSED)
    for (const name of ['Zmień kolejność zmian', 'Wymień zawodnika', 'Dodaj 4. osobę']) {
      await expect(page.getByRole('button', { name })).toHaveCount(0)
    }
    // Acceptance still works after close, so the reminder stays (7b review ruling).
    await expect(page.getByRole('button', { name: 'Wyślij przypomnienie do: Piotr Leśny' })).toBeVisible()
    await expect(page.getByText(/^Zmiany do/)).toHaveCount(0)
    await expect(rows(page).nth(0)).toContainText('Ola Leśna')
    await noButtonWraps(page)

    await page.reload()
    await expect(page.getByTestId('team-closed')).toHaveText(CLOSED)
    await expect(page.getByRole('button', { name: 'Wymień zawodnika' })).toHaveCount(0)
  })
}
