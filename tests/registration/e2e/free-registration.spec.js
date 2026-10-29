import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, localEnv, sessionFor } from '../helpers/stack.js'
import { clearMessages, lastCodeFor } from '../helpers/emailCapture.js'
import { callFn, createPublishedFreeEvent } from '../helpers/registrationFixtures.js'
import { startScratchHost } from '../helpers/hostPull.js'

// Plan 2 task 10: the public event page (RA1), the course (RA1b), the form
// (RA2) and the confirmation (RA5) for a free event, across audiences:
// W-36…W-40 and W-49, W-50 in docs/registration/scenario-matrix.md. The owner's
// side of the same event („Zgłoszenia”) is Task 8c. Map tiles are answered
// locally: tests never leave the machine.

const ZT = '00000000-0000-4000-8000-0000000000c1'
const GPX = readFileSync(new URL('../fixtures/gpx/loop-9km.gpx', import.meta.url))
const RETIRED_TEXT = 'Ten adres e-mail należał do usuniętego konta LESZY.RUN i nie może zostać użyty ponownie. Podaj inny adres albo napisz do nas: kontakt@leszy.run.'
const DUPLICATE_TEXT = 'Ten adres e-mail jest już zapisany na te zawody.'

const DAY_MS = 24 * 3600 * 1000
const isoDay = (offset) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10)
const BIEG = { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }
const MARSZ = { name: 'Marsz 5 km', discipline: 'nw', distanceLabel: '5 km', startTime: '10:05', capacity: 30 }
const OFFICE = {
  sameAsEvent: false, address: 'Szkoła Podstawowa, ul. Szkolna 4', lat: 50.24, lng: 18.54,
  hours: [{ date: isoDay(29), from: '17:00', to: '19:00' }, { date: isoDay(30), from: '08:00', to: '09:30' }],
}

let owner

// organizer-gate.spec.js removes the seed club's agreement when it finishes,
// so accept it again (through the edge function, see registrationFixtures.js).
test.beforeAll(async () => {
  owner = await sessionFor(ACTOR_EMAILS.owner)
  const status = await callFn('organizer-status', owner, { clubId: ZT })
  if (!status.body.data.agreementAccepted) {
    await callFn('accept-organizer-agreement', owner, { clubId: ZT, version: status.body.data.version })
  }
})

async function offline(page) {
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  return page
}

async function codeFor(email) {
  for (let i = 0; i < 40; i++) {
    const code = await lastCodeFor(email)
    if (code) return code
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`no code e-mail for ${email}`)
}

const consentBoxes = (page) => page.getByTestId('consents').getByRole('checkbox')

async function fillPerson(page, { first, last, birth, gender = 'Kobieta', email, phone = '600100200' }) {
  await page.locator('#p-first').fill(first)
  await page.locator('#p-last').fill(last)
  await page.locator('#p-birth').fill(birth)
  await page.getByRole('button', { name: gender, exact: true }).click()
  if (email !== undefined) await page.locator('#p-email').fill(email)
  if (phone !== undefined) await page.locator('#p-phone').fill(phone)
}

async function tickAll(page) {
  const boxes = consentBoxes(page)
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
}

const kmText = (km) => `${String(Number(km.toFixed(1))).replace('.', ',')} km`

test('W-36 viewer sees the event page and the course of a published free event', async ({ actors }) => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG], gpx: GPX, office: OFFICE })
  const { data: settings } = await admin().from('registration_settings').select('name').eq('event_id', event.eventId).single()
  const page = await offline(await actors.viewer.newPage())

  await page.goto(`/events/${event.slug}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(settings.name)
  await expect(page.getByTestId('stat-registered')).toContainText('Zapisani')
  await expect(page.getByTestId('stat-registered')).toContainText('0')
  await expect(page.getByTestId('stat-free')).toContainText('Wolne')
  await expect(page.getByTestId('stat-free')).toContainText('50')
  await expect(page.getByTestId('office')).toContainText('17:00–19:00')
  await expect(page.getByTestId('office')).toContainText('8:00–9:30')
  await expect(page.getByTestId('office')).toContainText('Szkoła Podstawowa, ul. Szkolna 4')
  const row = page.getByTestId('competition')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Bieg 9 km')
  await expect(row).toContainText('start 10:00')
  await expect(row).toContainText('Bezpłatne')
  await expect(page.getByText('Do płatności doliczamy')).toHaveCount(0)
  await expect(page.getByTestId('registration-event-page').getByRole('link', { name: 'Regulamin' })).toHaveAttribute('href', 'https://example.org/regulamin.pdf')

  await page.getByTestId('event-course').getByRole('link', { name: 'Pełny widok i GPX →' }).click()
  await expect(page).toHaveURL(new RegExp(`/events/${event.slug}/trasa$`))
  await expect(page.getByRole('heading', { name: 'Trasa' })).toBeVisible()
  await expect(page.getByTestId('course-tab')).toHaveText('9 km')
  const km = kmText(event.gpx.meta.km)
  expect(km).toBe('9,1 km')
  await expect(page.getByTestId('course-stats')).toContainText(km)
  await expect(page.getByTestId('course-map').locator('path.leaflet-interactive').first()).toBeVisible()
  await expect(page.getByTestId('elevation-profile')).toBeVisible()
  const download = page.getByRole('link', { name: 'Pobierz GPX' })
  // The stored file, by the upload row (the function's own `url` names the edge runtime's internal host locally).
  const { data: upload } = await admin().from('registration_uploads').select('path').eq('id', event.gpx.uploadId).single()
  const stored = `${localEnv().url}/storage/v1/object/public/registration-files/${upload.path}`
  expect(upload.path.startsWith(`${event.eventId}/gpx/`)).toBe(true)
  await expect(download).toHaveAttribute('href', stored)
  const file = await fetch(stored)
  expect(file.status).toBe(200)
  expect(await file.text()).toContain('<gpx')
})

// Warsaw „d.mm.rrrr” of an ISO day, as the deadline line prints it.
const dmy = (iso) => { const [y, m, d] = iso.split('-'); return `${Number(d)}.${m}.${y}` }

test('W-67 W-68 W-69 W-70 the event page shows the deadline, the start, the course inline, the regulamin and the contact', async ({ actors }) => {
  const event = await createPublishedFreeEvent(owner, {
    competitions: [BIEG, MARSZ], gpx: GPX, placeDetails: 'Boisko przy szkole',
    office: { ...OFFICE, sameAsEvent: true, address: null, lat: null, lng: null },
  })
  const page = await offline(await actors.viewer.newPage())
  await page.goto(`/events/${event.slug}`)
  const ra1 = page.getByTestId('registration-event-page')

  // W-68: the last minute of registration, Warsaw time.
  await expect(page.getByTestId('deadline')).toHaveText(`Zapisy do ${dmy(event.closesOn)}, 23:59`)

  // W-67: the start is the event place and pin; an office at the event says so instead of repeating it.
  await expect(page.getByTestId('start-place')).toHaveText('Nieborowice, Boisko przy szkole · mapa ↗')
  await expect(page.getByTestId('start-place')).toHaveAttribute('href', 'https://www.openstreetmap.org/?mlat=50.2381&mlon=18.5412#map=17/50.2381/18.5412')
  await expect(page.getByTestId('office')).toContainText('8:00–9:30')
  await expect(page.getByTestId('office-at-start')).toHaveText('W miejscu startu')
  await expect(page.getByTestId('office-place')).toHaveCount(0)

  // W-70: the course of the competition with a GPX, inline under the competitions, map and profile.
  const course = page.getByTestId('event-course')
  await expect(course.getByTestId('course-tab')).toHaveText('9 km')
  await expect(course.getByTestId('course-names')).toHaveText('BIEG 9 KM')
  await expect(course.getByTestId('course-map').locator('path.leaflet-interactive').first()).toBeVisible()
  await expect(course.getByTestId('elevation-profile')).toBeVisible()
  await expect(course.getByTestId('course-stats')).toContainText('9,1 km')

  // W-69: the regulamin and the organizer contact, always.
  await expect(ra1.getByTestId('regulamin-link')).toHaveAttribute('href', 'https://example.org/regulamin.pdf')
  await expect(ra1.getByTestId('contact-link')).toHaveText('zapisy@klub.example')
  await expect(ra1.getByTestId('contact-link')).toHaveAttribute('href', 'mailto:zapisy@klub.example')

  // The office with its own address keeps its own place line.
  const other = await createPublishedFreeEvent(owner, { office: OFFICE })
  await page.goto(`/events/${other.slug}`)
  await expect(page.getByTestId('start-place')).toHaveText('Nieborowice · mapa ↗')
  await expect(page.getByTestId('office-place')).toHaveText('Szkoła Podstawowa, ul. Szkolna 4 · mapa ↗')
  await expect(page.getByTestId('office-at-start')).toHaveCount(0)
  await expect(page.getByTestId('event-course')).toHaveCount(0)

  // Nothing scrolls sideways at 390 px.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/events/${event.slug}`)
  await expect(page.getByTestId('event-course').getByTestId('course-map')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test.describe.serial('a new runner registers with an e-mail code', () => {
  let event
  const email = 'nowa@test.local'

  test('W-37 viewer: consents unticked, button disabled until all are ticked, code, „Jesteście na liście”, no bib, no onboarding', async ({ actors }) => {
    event = await createPublishedFreeEvent(owner, { competitions: [BIEG] })
    await clearMessages()
    const page = await offline(await actors.viewer.newPage())
    const visited = []
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) visited.push(f.url()) })

    await page.goto(`/events/${event.slug}`)
    await page.getByTestId('competition').filter({ hasText: 'Bieg 9 km' }).click()
    await expect(page).toHaveURL(new RegExp(`/events/${event.slug}/zapis/${event.categoryIds[0]}$`))
    await expect(page.getByTestId('login-offer')).toBeVisible()

    const boxes = consentBoxes(page)
    await expect(boxes).toHaveCount(4) // regulamin, data information, image (P2-R33), LESZY.RUN service regulamin
    for (let i = 0; i < 4; i++) await expect(boxes.nth(i)).not.toBeChecked()
    await expect(page.getByTestId('consents')).toContainText('mój wizerunek utrwalony podczas zawodów')
    await expect(page.getByTestId('consents').getByRole('link', { name: 'regulaminem' })).toHaveAttribute('href', 'https://example.org/regulamin.pdf')
    await expect(page.locator('#p-nationality')).toHaveCount(0) // off by default (P2-R31)
    await expect(page.locator('label[for="p-phone"]')).toHaveText('Telefon') // always required (P2-R32)
    await expect(page.getByText('wymagane do zapisu')).toBeVisible()
    const submit = page.getByTestId('registration-submit')
    await expect(submit).toBeDisabled()

    await fillPerson(page, { first: 'Nowa', last: 'Biegaczka', birth: '1990-04-12', email })
    await expect(page.getByTestId('category-preview')).toContainText('K open')
    await boxes.nth(0).check()
    await boxes.nth(1).check()
    await boxes.nth(3).check()
    await expect(submit).toBeDisabled() // the image acceptance is still unticked
    await boxes.nth(2).check()
    await expect(submit).toBeEnabled()
    await expect(submit).toHaveText('Dalej')
    await submit.click()

    await expect(page.getByTestId('code-step')).toBeVisible()
    await expect(page.getByTestId('code-step')).toContainText(email)
    await page.getByLabel('Kod (6 cyfr)').fill(await codeFor(email))
    await page.getByRole('button', { name: 'Zapisz się' }).click()

    await expect(page).toHaveURL(new RegExp(`/events/${event.slug}/zapisano$`))
    await expect(page.getByText('Jesteście na liście')).toBeVisible()
    const person = page.getByTestId('done-person')
    await expect(person).toHaveCount(1)
    await expect(person).toContainText('Nowa Biegaczka')
    await expect(person).toContainText('Bieg 9 km')
    await expect(person).toContainText('K open')
    await expect(person).toContainText('start 10:00')
    await expect(page.getByTestId('write-organizer')).toHaveAttribute('href', /^mailto:zapisy@klub\.example\?subject=/)
    await expect(page.getByText(/numer startowy|nr startowy|bib/i)).toHaveCount(0)
    expect(visited.some((u) => u.includes('/onboarding'))).toBe(false)
    expect(visited.some((u) => /nowa|biegaczka|test\.local/i.test(decodeURIComponent(u)))).toBe(false)
  })

  test('W-37b a plain /login with a registration page in ?from= still sends the new account through onboarding (P2-R22)', async ({ actors }) => {
    await clearMessages()
    const page = await offline(await actors.viewer.newPage())
    const from = `/events/${event.slug}/zapisano`
    await page.goto(`/login?from=${encodeURIComponent(from)}`)
    await page.getByLabel('Email').fill(email)
    await page.locator('form button[type="submit"]').click()
    await page.getByLabel('Kod (6 cyfr)').fill(await codeFor(email))
    await page.locator('form button[type="submit"]').click()
    await expect(page).toHaveURL((u) => u.pathname === '/onboarding' && u.searchParams.get('from') === from)
  })

  test('W-38 the registration is a participants row, and the timing host pulls it', async () => {
    const { data: regs } = await admin().from('registrations').select('id').eq('event_id', event.eventId).eq('email', email)
    expect(regs).toHaveLength(1)
    const { data: part } = await admin().from('participants').select('first_name, last_name, bib_number')
      .eq('registration_id', regs[0].id).single()
    expect(part).toEqual({ first_name: 'Nowa', last_name: 'Biegaczka', bib_number: null })

    const host = await startScratchHost()
    try {
      await host.pull()
      const rows = await host.sql`select first_name, registration_id from participants where event_id = ${event.eventId}`
      expect(rows.map((r) => ({ ...r }))).toEqual([{ first_name: 'Nowa', registration_id: regs[0].id }])
    } finally {
      await host.stop()
    }
  })

  test('W-38 tabs: the owner\'s „Zgłoszenia” lists the runner, the header counts „1 / 50 zapisanych”; a member has no such tab', async ({ actors }) => {
    const base = `/klub/zatyrani-test/wydarzenia/${event.eventId}`
    const page = await offline(await actors.owner.newPage())
    await page.goto(base)
    await expect(page).toHaveURL(new RegExp(`${base}/zgloszenia$`))
    const tabs = page.getByRole('tablist', { name: 'Zakładki' })
    await expect(tabs.getByRole('tab', { name: 'Zgłoszenia' })).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.getByRole('tab', { name: /Podstawy/ })).toBeVisible()
    await expect(tabs.getByRole('tab', { name: /Publikacja/ })).toHaveCount(0)
    await expect(page.getByTestId('save-status')).toHaveText(new RegExp(`OPUBLIKOWANE · ZAPISY DO ${Number(event.closesOn.slice(8))}\\.${event.closesOn.slice(5, 7)}`))
    await expect(page.getByTestId('registered-count')).toHaveText('1 / 50 zapisanych')
    const list = page.getByTestId('registrations')
    await expect(list).toContainText('Nowa Biegaczka')
    await expect(list).toContainText('Bieg 9 km')
    await expect(list).toContainText('K open')
    await expect(page.getByRole('link', { name: 'Strona zawodów ↗' })).toHaveAttribute('href', `/events/${event.slug}`)
    await expect(page.getByRole('button', { name: 'Kopiuj link' })).toBeVisible()
    // No office hours yet: flagged, and „Uzupełnij” opens Biuro zawodów.
    await expect(page.getByTestId('missing-banner')).toContainText('Brakuje: godziny otwarcia biura zawodów')
    await page.getByTestId('missing-banner').getByRole('link', { name: 'Uzupełnij' }).click()
    await expect(page).toHaveURL(new RegExp(`${base}/biuro$`))
    await expect(tabs.getByRole('tab', { name: /Biuro zawodów/ })).toHaveAttribute('aria-selected', 'true')

    // Runner personal data is owner/admin only (P2-R20).
    const mem = await offline(await actors.member.newPage())
    await mem.goto(`${base}/zgloszenia`)
    await expect(mem).toHaveURL(new RegExp(`${base}/podstawy$`))
    await expect(mem.getByRole('tab', { name: 'Zgłoszenia' })).toHaveCount(0)
    await expect(mem.getByTestId('registrations')).toHaveCount(0)
    await expect(mem.getByTestId('registered-count')).toHaveText('1 / 50 zapisanych')
  })
})

test('W-39 a logged-in runner gets their own e-mail prefilled, registers without a code, and a second time is refused', async ({ actors }) => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG] })
  const { error } = await admin().from('profiles').update({ gender: 'F', date_of_birth: '1988-06-01' }).eq('email', ACTOR_EMAILS.runner)
  expect(error).toBeNull()
  await clearMessages()
  const page = await offline(await actors.runner.newPage())
  const form = `/events/${event.slug}/zapis/${event.categoryIds[0]}`

  await page.goto(form)
  await expect(page.locator('#p-email')).toHaveValue(ACTOR_EMAILS.runner)
  await expect(page.locator('#p-birth')).toHaveValue('1988-06-01')
  await expect(page.getByRole('button', { name: 'Kobieta', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#p-first')).toHaveValue('')
  await expect(page.getByTestId('login-offer')).toHaveCount(0)

  await page.locator('#p-first').fill('Ola')
  await page.locator('#p-last').fill('Leśna')
  await page.locator('#p-phone').fill('600100200')
  await tickAll(page)
  await expect(page.getByTestId('registration-submit')).toHaveText('Zapisz się')
  await page.getByTestId('registration-submit').click()
  await expect(page).toHaveURL(new RegExp(`/events/${event.slug}/zapisano$`))
  await expect(page.getByTestId('done-person')).toContainText('Ola Leśna')
  expect(await lastCodeFor(ACTOR_EMAILS.runner)).toBeNull()

  await page.goto(form)
  await page.locator('#p-first').fill('Ola')
  await page.locator('#p-last').fill('Leśna')
  await page.locator('#p-phone').fill('600100200')
  await tickAll(page)
  await page.getByTestId('registration-submit').click()
  await expect(page.locator('#p-email-error')).toHaveText(DUPLICATE_TEXT)
  await expect(page).toHaveURL(new RegExp(`${form}$`))
})

test('W-40 a draft slug opened by a viewer shows the ordinary not-found view, never draft data', async ({ actors }) => {
  const name = `Tajny Szkic ${crypto.randomUUID().slice(0, 6)}`
  const created = await callFn('create-registration-event', owner, { clubId: ZT, name })
  expect(created.status).toBe(201)
  const { data: draft } = await admin().from('registration_settings').select('slug, state').eq('event_id', created.body.data.eventId).single()
  expect(draft.state).toBe('draft')
  const page = await offline(await actors.viewer.newPage())

  for (const path of [`/events/${draft.slug}`, `/events/${draft.slug}/trasa`]) {
    await page.goto(path)
    await expect(page.getByTestId('registration-event-page')).toHaveCount(0)
    await expect(page.getByTestId('course-page')).toHaveCount(0)
    await expect(page.getByText(name)).toHaveCount(0)
  }
  await page.goto(`/events/${draft.slug}`)
  await expect(page.getByText('Event not found')).toBeVisible()
})

test('W-49 a competition hidden after publish disappears for the viewer, its form included', async ({ actors }) => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG, MARSZ] })
  const page = await offline(await actors.viewer.newPage())
  await page.goto(`/events/${event.slug}`)
  await expect(page.getByTestId('competition')).toHaveCount(2)

  const items = [BIEG, MARSZ].map((c, i) => ({ kind: 'individual', timed: true, isKids: false, ...c, categoryId: event.categoryIds[i], ...(i === 1 ? { hidden: true } : {}) }))
  const saved = await callFn('save-registration-section', owner, { eventId: event.eventId, section: 'competitions', value: { pricingMode: 'free', items } })
  expect(saved.status).toBe(200)
  const published = await callFn('publish-registration-event', owner, { eventId: event.eventId, action: 'publish_changes', notify: { send: false } })
  expect(published.status, JSON.stringify(published.body)).toBe(200)

  await page.reload()
  await expect(page.getByTestId('competition')).toHaveCount(1)
  await expect(page.getByTestId('competition')).toContainText('Bieg 9 km')
  await expect(page.getByText('Marsz 5 km')).toHaveCount(0)
  await expect(page.getByTestId('stat-free')).toContainText('50')

  await page.goto(`/events/${event.slug}/zapis/${event.categoryIds[1]}`)
  await expect(page.getByTestId('competition-unavailable')).toBeVisible()
  await expect(page.getByTestId('registration-form')).toHaveCount(0)
})

test('W-50 a deleted account\'s address in the form shows Plan 1\'s message under the e-mail field, no code is sent', async ({ actors }) => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG] })
  const email = `retired-form-${Date.now()}@test.local`
  const hash = crypto.createHash('sha256').update(email).digest('hex')
  const { error } = await admin().from('deleted_email_hashes').upsert({ email_hash: hash }, { onConflict: 'email_hash' })
  expect(error).toBeNull()
  const page = await offline(await actors.viewer.newPage())

  await page.goto(`/events/${event.slug}/zapis/${event.categoryIds[0]}`)
  await fillPerson(page, { first: 'Ex', last: 'Konto', birth: '1985-01-01', gender: 'Mężczyzna', email })
  await tickAll(page)
  await page.getByTestId('registration-submit').click()
  await expect(page.locator('#p-email-error')).toHaveText(RETIRED_TEXT)
  await expect(page.getByTestId('code-step')).toHaveCount(0)
  expect(await lastCodeFor(email)).toBeNull()
})

test('W-64 W-65 nationality asked as required: a Polish-named select, Polska first; an empty phone and no country are refused on the form; the ISO code is stored', async ({ actors }) => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG] })
  const { data: rs } = await admin().from('registration_settings').select('form_fields').eq('event_id', event.eventId).single()
  const { error } = await admin().from('registration_settings')
    .update({ form_fields: { ...rs.form_fields, nationality: 'required', phone: 'off' } }).eq('event_id', event.eventId)
  expect(error).toBeNull()
  const email = `narodowosc-${crypto.randomBytes(4).toString('hex')}@test.local`
  const page = await offline(await actors.viewer.newPage())
  await page.goto(`/events/${event.slug}/zapis/${event.categoryIds[0]}`)

  const select = page.locator('#p-nationality')
  await expect(page.locator('label[for="p-nationality"]')).toHaveText('Narodowość')
  const options = select.locator('option')
  await expect(options).toHaveCount(250) // an empty choice and 249 ISO countries
  await expect(options.nth(0)).toHaveText('— wybierz —')
  await expect(options.nth(1)).toHaveText('Polska')
  await expect(options.nth(1)).toHaveAttribute('value', 'PL')
  await expect(page.locator('#p-phone')).toBeVisible() // a stored phone: 'off' is ignored

  await fillPerson(page, { first: 'Anna', last: 'Nowak', birth: '1990-04-12', email, phone: '' })
  await tickAll(page)
  await page.getByTestId('registration-submit').click()
  await expect(page.locator('#p-phone-error')).toHaveText('Podaj numer telefonu.')
  await expect(page.locator('#p-nationality-error')).toHaveText('Wybierz narodowość.')

  await page.locator('#p-phone').fill('600100200')
  await select.selectOption({ label: 'Niemcy' })
  await page.getByTestId('registration-submit').click()
  await page.getByLabel('Kod (6 cyfr)').fill(await codeFor(email))
  await page.getByRole('button', { name: 'Zapisz się' }).click()
  await expect(page).toHaveURL(new RegExp(`/events/${event.slug}/zapisano$`))
  const { data: reg } = await admin().from('registrations').select('nationality, phone').eq('category_id', event.categoryIds[0]).single()
  expect(reg).toEqual({ nationality: 'DE', phone: '600100200' })
})
