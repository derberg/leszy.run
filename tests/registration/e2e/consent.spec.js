import crypto from 'node:crypto'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { clearMessages, lastCodeFor } from '../helpers/emailCapture.js'
import { callFn, createPublishedFreeEvent } from '../helpers/registrationFixtures.js'

// Plan 4 task 6: the consent page /zgoda and the organizer's consent states, in the browser.
// G-49, G-52 and G-54 in docs/registration/scenario-matrix.md (G-48 is the unit test of the
// fragment handling). The added adult is `invitee`, an anonymous context: they hold the link
// from the e-mail and nothing else.

const ZT = '00000000-0000-4000-8000-0000000000c1'
const BIEG = { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }
const GONE_LINK = 'Ten link został już użyty albo wygasł.'
const rand = () => crypto.randomBytes(4).toString('hex')
const email = (tag) => `runner-${tag}-${rand()}@test.local`
// As _shared/registration/tokens.js (which Playwright's loader cannot import): 32 random bytes,
// base64url in the link, the SHA-256 hex in consent_requests.
function newToken() {
  const token = crypto.randomBytes(32).toString('base64url')
  return { token, hash: crypto.createHash('sha256').update(token).digest('hex') }
}

let owner

test.beforeAll(async () => {
  owner = await sessionFor(ACTOR_EMAILS.owner)
  const status = await callFn('organizer-status', owner, { clubId: ZT })
  if (!status.body.data.agreementAccepted) {
    await callFn('accept-organizer-agreement', owner, { clubId: ZT, version: status.body.data.version })
  }
})
test.beforeEach(async () => { await resetThrottle() })

async function offline(page) {
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  return page
}

/**
 * A free event, a payer who registered themself and an added adult (Piotr Borowy, awaiting), and
 * a consent request whose token the test knows. → { event, regId, adultEmail, token }
 */
async function awaitingAdult() {
  const name = `Bieg Zgody ${rand()}`
  const event = { ...(await createPublishedFreeEvent(owner, { name, competitions: [BIEG] })), name }
  const cat = event.categoryIds[0]
  const db = admin()
  const payerEmail = email('payer')
  const adultEmail = email('invitee')
  const payer = await sessionFor(payerEmail)
  const { data: consents } = await db.from('event_consents').select('id').eq('event_id', event.eventId)
  const person = (address, over) => ({
    categoryId: cat, firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-01-01', gender: 'K', email: address,
    phone: '+48500100200', ageGroupLabel: 'K open', ...over,
  })
  const { data, error } = await db.rpc('register_free', {
    p_people: [
      { ...person(payerEmail), role: 'self' },
      { ...person(adultEmail, { firstName: 'Piotr', lastName: 'Borowy', gender: 'M', ageGroupLabel: 'M open', phone: '+48600700800' }), role: 'adult' },
    ],
    p_profile_id: payer.profileId,
    p_meta: { buyerName: 'Ola Leśna', consentIds: consents.map((c) => c.id), ip: '203.0.113.9', userAgent: 'test' },
  })
  if (error) throw new Error(`register_free: ${error.message}`)
  const regId = data.registrations.find((r) => r.role === 'adult').id
  const t = newToken()
  const issued = await db.rpc('issue_consent_request', { p_registration_id: regId, p_token_hash: t.hash })
  if (issued.data !== true) throw new Error(`issue_consent_request: ${issued.error?.message}`)
  return { event, regId, adultEmail, token: t.token }
}

test.describe('the consent page', () => {
  for (const width of [390, 1440]) {
    test(`G-49 (${width} px) invitee: code, data, every box, thank you; the fragment never leaves the page; the link again → used`, async ({ actors }) => {
      const { event, regId, adultEmail, token } = await awaitingAdult()
      await clearMessages()
      const page = await offline(await actors.invitee.newPage())
      await page.setViewportSize({ width, height: 900 })

      // Every request the page makes, and the address bar at the moment of the first consent-request.
      const seen = []
      page.on('request', (r) => seen.push(`${r.url()} ${r.headers().referer ?? ''}`))
      const hashAtFirstCall = []
      await page.route('**/edge/consent-request', async (route) => {
        if (hashAtFirstCall.length === 0) hashAtFirstCall.push(await page.evaluate(() => window.location.href))
        await route.continue()
      })

      await page.goto(`/zgoda#${token}`)
      const step = page.getByTestId('consent-code-step')
      await expect(step).toBeVisible()
      await expect(page).toHaveURL(/\/zgoda$/)
      expect(hashAtFirstCall[0]).toMatch(/\/zgoda$/)
      await expect(step).toContainText(event.name)
      await expect(step).toContainText('Piotr')
      await expect(step).toContainText(/Wyślemy kod na r\*\*\*@t\*\*\*\.local/)
      // The link alone shows nobody's data (ruling 11).
      await expect(page.locator('body')).not.toContainText('Borowy')
      await expect(page.locator('body')).not.toContainText('600700800')

      await page.getByRole('button', { name: 'Wyślij kod' }).click()
      await expect(page.locator('#consent-code')).toBeVisible()
      await expect(step.getByTestId('consent-code-hint')).toHaveText('Wpisz kod z e-maila w polu poniżej.')
      await expect(page.locator('header, nav').first()).toContainText('Zaloguj się')
      let code = null
      for (let i = 0; i < 40 && !code; i++) { code = await lastCodeFor(adultEmail); if (!code) await page.waitForTimeout(250) }
      expect(code).toMatch(/^\d{6}$/)
      await page.locator('#consent-code').fill(code)
      await page.getByRole('button', { name: 'Dalej' }).click()

      const form = page.getByTestId('consent-form')
      await expect(form).toBeVisible()
      // The code signed the person in, and the navbar says so without a reload (M-1).
      await expect(page.locator('header, nav').first()).not.toContainText('Zaloguj się')
      await expect(page.locator('#p-last')).toHaveValue('Borowy')
      await expect(page.locator('#p-email')).toHaveValue(adultEmail)
      await expect(page.locator('#p-email')).toHaveJSProperty('readOnly', true)
      const boxes = page.getByTestId('consents').getByRole('checkbox')
      await expect(boxes).toHaveCount(4)
      const submit = page.getByRole('button', { name: 'Akceptuję regulamin' })
      await expect(submit).toBeDisabled()
      for (let i = 0; i < 4; i++) await boxes.nth(i).check()
      await page.locator('#p-phone').fill('+48600700999')
      await submit.click()

      await expect(page.getByTestId('consent-done')).toContainText('Dziękujemy — regulamin zaakceptowany.')
      const { data: reg } = await admin().from('registrations').select('consent_state, phone').eq('id', regId).single()
      expect(reg).toEqual({ consent_state: 'accepted', phone: '+48600700999' })

      // The token appears in no request URL and no referrer.
      for (const line of seen) expect(line).not.toContain(token)

      // The link again: used.
      const again = await offline(await actors.invitee.newPage())
      await again.goto(`/zgoda#${token}`)
      await expect(again.getByTestId('consent-gone')).toContainText(GONE_LINK)
      await expect(again).toHaveURL(/\/zgoda$/)
    })
  }

  test('G-49b a wrong code is answered on the code step; /zgoda without a fragment never calls the server', async ({ actors }) => {
    const { token } = await awaitingAdult()
    const page = await offline(await actors.invitee.newPage())
    await page.goto(`/zgoda#${token}`)
    await page.getByRole('button', { name: 'Wyślij kod' }).click()
    await page.locator('#consent-code').fill('000000')
    await page.getByRole('button', { name: 'Dalej' }).click()
    await expect(page.getByTestId('consent-code-error')).toHaveText('Nieprawidłowy kod.')
    await expect(page.locator('#consent-code')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('#consent-code')).toHaveAttribute('aria-describedby', 'consent-code-error')

    const bare = await offline(await actors.invitee.newPage())
    const calls = []
    bare.on('request', (r) => { if (r.url().includes('/edge/consent-request')) calls.push(r.url()) })
    await bare.goto('/zgoda')
    await expect(bare.getByTestId('consent-gone')).toContainText(GONE_LINK)
    expect(calls).toEqual([])
  })
})

test('G-55 a consent published while the page is open: the boxes are shown again, unticked, with the new one; after closes_at the data is read only and acceptance still works', async ({ actors }) => {
  const { event, regId, adultEmail, token } = await awaitingAdult()
  await clearMessages()
  const page = await offline(await actors.invitee.newPage())
  await page.goto(`/zgoda#${token}`)
  await page.getByRole('button', { name: 'Wyślij kod' }).click()
  let code = null
  for (let i = 0; i < 40 && !code; i++) { code = await lastCodeFor(adultEmail); if (!code) await page.waitForTimeout(250) }
  await page.locator('#consent-code').fill(code)
  await page.getByRole('button', { name: 'Dalej' }).click()
  const boxes = page.getByTestId('consents').getByRole('checkbox')
  await expect(boxes).toHaveCount(4)

  const db = admin()
  const added = await db.from('event_consents').insert({ event_id: event.eventId, kind: 'custom', text: 'Zgoda dopisana w trakcie', sort_order: 9 }).select('id').single()
  expect(added.error).toBeNull()
  // Registration closes meanwhile too: corrections go to the office.
  const closed = await db.from('registration_settings').update({ closes_at: new Date(Date.now() - 60_000).toISOString() }).eq('event_id', event.eventId)
  expect(closed.error).toBeNull()

  for (let i = 0; i < 4; i++) await boxes.nth(i).check()
  await page.getByRole('button', { name: 'Akceptuję regulamin' }).click()
  await expect(boxes).toHaveCount(5)
  await expect(page.getByTestId('consents')).toContainText('Zgoda dopisana w trakcie')
  await expect(page.getByTestId('consents')).toContainText('Zaznacz wymagane zgody.')
  for (let i = 0; i < 5; i++) await expect(boxes.nth(i)).not.toBeChecked()
  await expect(page.getByTestId('consent-edits-closed')).toBeVisible()
  await expect(page.locator('#p-phone')).toBeDisabled()

  for (let i = 0; i < 5; i++) await boxes.nth(i).check()
  await page.getByRole('button', { name: 'Akceptuję regulamin' }).click()
  await expect(page.getByTestId('consent-done')).toContainText('Dziękujemy — regulamin zaakceptowany.')
  const { data: acc } = await db.from('consent_acceptances').select('consent_kind').eq('registration_id', regId)
  expect(acc.map((a) => a.consent_kind).sort()).toEqual(['custom', 'data_info', 'image', 'regulamin', 'service_regulamin'])
})

/** Opens the link as `invitee`, sends the code and enters it: → the page on the consent form. */
async function throughCode(actors, token, adultEmail, { before } = {}) {
  const page = await offline(await actors.invitee.newPage())
  if (before) await before(page)
  await page.goto(`/zgoda#${token}`)
  await page.getByRole('button', { name: 'Wyślij kod' }).click()
  let code = null
  for (let i = 0; i < 40 && !code; i++) { code = await lastCodeFor(adultEmail); if (!code) await page.waitForTimeout(250) }
  await page.locator('#consent-code').fill(code)
  await page.getByRole('button', { name: 'Dalej' }).click()
  return page
}

test('G-56 a consent published while the person has corrected their data: only the boxes are shown again; the corrections stay and are saved', async ({ actors }) => {
  const { event, regId, adultEmail, token } = await awaitingAdult()
  await clearMessages()
  const page = await throughCode(actors, token, adultEmail)
  const boxes = page.getByTestId('consents').getByRole('checkbox')
  await expect(boxes).toHaveCount(4)
  await page.locator('#p-phone').fill('+48600111222')
  await page.locator('#p-city').fill('Zabrze')

  const added = await admin().from('event_consents').insert({ event_id: event.eventId, kind: 'custom', text: 'Zgoda dopisana w trakcie', sort_order: 9 }).select('id').single()
  expect(added.error).toBeNull()
  for (let i = 0; i < 4; i++) await boxes.nth(i).check()
  await page.getByRole('button', { name: 'Akceptuję regulamin' }).click()

  await expect(boxes).toHaveCount(5)
  await expect(page.getByTestId('consents')).toContainText('Zaznacz wymagane zgody.')
  for (let i = 0; i < 5; i++) await expect(boxes.nth(i)).not.toBeChecked()
  await expect(page.locator('#p-phone')).toHaveValue('+48600111222')
  await expect(page.locator('#p-city')).toHaveValue('Zabrze')
  await expect(page.locator('#p-phone')).toBeEnabled()

  for (let i = 0; i < 5; i++) await boxes.nth(i).check()
  await page.getByRole('button', { name: 'Akceptuję regulamin' }).click()
  await expect(page.getByTestId('consent-done')).toBeVisible()
  const { data: reg } = await admin().from('registrations').select('phone, city, consent_state').eq('id', regId).single()
  expect(reg).toEqual({ phone: '+48600111222', city: 'Zabrze', consent_state: 'accepted' })
})

test('G-57 the first read or the event data fails: no consent form, „Spróbuj ponownie” loads it', async ({ actors }) => {
  const { adultEmail, token } = await awaitingAdult()
  await clearMessages()

  // The first consent-request fails: the error step, then a retry.
  const first = await offline(await actors.invitee.newPage())
  let failRead = true
  await first.route('**/edge/consent-request', (route) => (failRead
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal server error' }) })
    : route.continue()))
  await first.goto(`/zgoda#${token}`)
  await expect(first.getByTestId('consent-load-error')).toContainText('Internal server error')
  failRead = false
  await first.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  await expect(first.getByTestId('consent-code-step')).toBeVisible()
  await first.close()

  // /api/event fails after the code: no form, an error with a retry, then the form.
  let failEvent = true
  const page = await throughCode(actors, token, adultEmail, {
    before: (p) => p.route(/\/api\/event\?slug=/, (route) => (failEvent ? route.fulfill({ status: 503, body: '' }) : route.continue())),
  })
  await expect(page.getByTestId('consent-event-error')).toContainText('Nie udało się wczytać danych zawodów.')
  await expect(page.getByTestId('consent-form')).toHaveCount(0)
  failEvent = false
  await page.getByTestId('consent-event-error').getByRole('button', { name: 'Spróbuj ponownie' }).click()
  await expect(page.getByTestId('consent-form')).toBeVisible()
  await expect(page.getByTestId('consents').getByRole('checkbox')).toHaveCount(4)
})

test('G-57b a retired address: the code step says so and the tab no longer keeps the link', async ({ actors }) => {
  const { adultEmail, token } = await awaitingAdult()
  const hash = crypto.createHash('sha256').update(adultEmail.toLowerCase()).digest('hex')
  const retired = await admin().from('deleted_email_hashes').insert({ email_hash: hash })
  expect(retired.error).toBeNull()
  const page = await offline(await actors.invitee.newPage())
  await page.goto(`/zgoda#${token}`)
  await page.getByRole('button', { name: 'Wyślij kod' }).click()
  await expect(page.getByTestId('consent-code-error')).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('leszy.consent.token'))).toBeNull()
})

test('G-52 owner: „Czeka na zgody: 1”, the filter, cards at 390 px, „Podpisany w biurze” asks first (Nie keeps it, Tak marks it) → „podpisany w biurze” and the count is 0', async ({ actors }) => {
  const { event, regId } = await awaitingAdult()
  const page = await offline(await actors.owner.newPage())
  await page.goto(`/klub/zatyrani-test/wydarzenia/${event.eventId}/zgloszenia`)
  const list = page.getByTestId('registrations')
  await expect(list).toContainText('Piotr Borowy')
  const pending = page.getByTestId('awaiting-consent')
  await expect(pending).toContainText('Czeka na zgody: 1')

  const rows = list.locator('tbody tr')
  await expect(rows).toHaveCount(2)
  // At 390 px every person is a card with the state and the buttons in view; the page never scrolls sideways.
  await page.setViewportSize({ width: 390, height: 900 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  const card = page.getByTestId('registration-card').filter({ hasText: 'Piotr Borowy' })
  await expect(card.getByTestId('registration-consent')).toHaveText('czeka na zgodę')
  const cardBtn = card.getByRole('button', { name: 'Podpisany w biurze — Piotr Borowy' })
  await cardBtn.scrollIntoViewIfNeeded()
  const box = await cardBtn.boundingBox()
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await page.setViewportSize({ width: 1280, height: 900 })
  await pending.getByRole('button').click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Piotr Borowy')
  await expect(rows.first().getByTestId('registration-consent')).toHaveText('czeka na zgodę')
  await pending.getByRole('button').click()
  await expect(rows).toHaveCount(2)
  await expect(list.getByText('Ola Leśna', { exact: true })).toBeVisible()
  await expect(list.locator('tr', { hasText: /^Ola Leśna/ }).getByTestId('registration-consent')).toHaveText('✓ zaakceptowany')
  // Who added Piotr, from the server's registeredBy.
  await expect(list.locator('tr', { hasText: 'Piotr Borowy' }).getByTestId('registration-sub')).toHaveText('zapisał(a): Ola Leśna')

  const adultRow = list.locator('tr', { hasText: 'Piotr Borowy' })
  // Each row's buttons name their person (M-7).
  await expect(adultRow.getByRole('button', { name: 'Przypomnij — Piotr Borowy', exact: true })).toBeVisible()
  const office = adultRow.getByRole('button', { name: 'Podpisany w biurze — Piotr Borowy', exact: true })

  // I-1: the office mark asks first; „Nie” changes nothing.
  await office.click()
  const confirm = adultRow.getByTestId('office-confirm')
  await expect(confirm).toContainText('Potwierdzić podpis w biurze: Piotr Borowy?')
  await confirm.getByRole('button', { name: 'Nie' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(office).toBeFocused()
  await expect(adultRow.getByTestId('registration-consent')).toHaveText('czeka na zgodę')
  await expect(pending).toContainText('Czeka na zgody: 1')
  const { data: still } = await admin().from('registrations').select('consent_state').eq('id', regId).single()
  expect(still.consent_state).toBe('awaiting')

  await office.click()
  await adultRow.getByTestId('office-confirm').getByRole('button', { name: 'Tak' }).click()
  await expect(adultRow.getByTestId('registration-consent')).toHaveText('podpisany w biurze')
  await expect(pending).toContainText('Czeka na zgody: 0')
  await expect(adultRow.getByRole('button', { name: 'Podpisany w biurze' })).toHaveCount(0)

  // It holds after a reload (the server's state, not the page's).
  await page.reload()
  await expect(page.getByTestId('awaiting-consent')).toContainText('Czeka na zgody: 0')
  await expect(page.getByTestId('registrations').locator('tr', { hasText: 'Piotr Borowy' }).getByTestId('registration-consent'))
    .toHaveText('podpisany w biurze')
})

test('G-54 /events/<slug>/informacja-o-danych: the runner data information for that event; an unknown slug is the 404 page', async ({ actors }) => {
  const { event } = await awaitingAdult()
  const page = await offline(await actors.viewer.newPage())
  await page.goto(`/events/${event.slug}/informacja-o-danych`)
  const info = page.getByTestId('data-info-page')
  await expect(info.getByRole('heading', { level: 1 })).toHaveText('Informacja o przetwarzaniu danych zawodnika')
  await expect(info).toContainText(`Administratorem Twoich danych podanych przy zapisie na ${event.name}`)
  await expect(info).toContainText('Kto otrzymuje dane')
  // A free event: nothing about payment.
  await expect(info).not.toContainText('dpay')

  await page.goto('/events/nie-ma-takich-zawodow-xyz/informacja-o-danych')
  await expect(page.getByTestId('data-info-page')).toHaveCount(0)
})
