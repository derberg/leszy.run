import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, localEnv, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedFreeEvent, makeClub } from '../helpers/registrationFixtures.js'
import { clearMessages, messagesTo } from '../helpers/emailCapture.js'

// Plan 2 task 8: the organizer wizard. W-25 (owner: every step, reloads, the
// checklist, the runner preview and publish), W-26 (admin edits, member reads,
// outsiders get 404), W-52 (Konkurencje after publish), W-27 (A8 pending bar
// and the A8a dialog), W-57 (discard) and W-58 (the refused-step alert).
// Nominatim and the map tiles are answered locally: tests never leave the machine.
// Playwright loads the Deno-side modules as CommonJS, so nothing here imports
// supabase/functions/_shared: the agreement goes through its own edge function.

const ZT = '00000000-0000-4000-8000-0000000000c1'

const NOMINATIM = [
  {
    lat: '50.2381', lon: '18.5412', name: 'Nieborowice',
    address: { village: 'Nieborowice', municipality: 'gmina Pilchowice', county: 'powiat gliwicki', state: 'województwo śląskie' },
  },
  {
    lat: '52.0661', lon: '20.0547', name: 'Nieborów',
    address: { village: 'Nieborów', municipality: 'gmina Nieborów', county: 'powiat łowicki', state: 'województwo łódzkie' },
  },
]

const GPX = readFileSync(new URL('../fixtures/gpx/loop-9km.gpx', import.meta.url))
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n% LESZY.RUN regulamin\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF\n')])

async function offline(page) {
  const nominatim = []
  await page.route('https://nominatim.openstreetmap.org/**', (route) => {
    nominatim.push(route.request().url())
    return route.fulfill({ json: NOMINATIM })
  })
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  return nominatim
}

async function settingsOf(eventId) {
  const { data, error } = await admin().from('registration_settings').select('*').eq('event_id', eventId).single()
  if (error) throw error
  return data
}

test.describe.configure({ mode: 'serial' })

// organizer-gate.spec.js removes the seed club's agreement when it finishes.
async function acceptAgreement() {
  const { cookie } = await sessionFor(ACTOR_EMAILS.owner)
  const call = async (fn, body) => {
    const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
    })
    return res.json()
  }
  const { data } = await call('organizer-status', { clubId: ZT })
  if (!data.agreementAccepted) await call('accept-organizer-agreement', { clubId: ZT, version: data.version })
}
test.beforeAll(acceptAgreement)

async function competitionsOf(eventId) {
  const { data, error } = await admin().from('competitions').select('*').eq('event_id', eventId).order('sort_order')
  if (error) throw error
  return data
}

test('W-25 owner creates an event, fills every step, reloads, previews as a runner and publishes', async ({ actors }) => {
  test.setTimeout(180_000)
  const name = `Bieg Leszego W25 ${crypto.randomUUID().slice(0, 6)}`
  const page = await actors.owner.newPage()
  const nominatim = await offline(page)

  // A1: the list, then the name prompt.
  await page.goto('/klub/zatyrani-test/wydarzenia')
  await page.getByRole('button', { name: '+ Nowe wydarzenie' }).click()
  await page.getByLabel('Nazwa wydarzenia').fill(name)
  await page.getByRole('button', { name: 'Utwórz' }).click()
  await expect(page).toHaveURL(/\/klub\/zatyrani-test\/wydarzenia\/[0-9a-f-]{36}\/podstawy$/)
  const eventId = page.url().split('/').at(-2)

  // A2: Podstawy.
  await expect(page.getByRole('heading', { name: 'Podstawy' })).toBeVisible()
  await expect(page.getByTestId('save-status')).toContainText('SZKIC · ZAPISANO AUTOMATYCZNIE')
  await expect(page.getByLabel('Nazwa', { exact: true })).toHaveValue(name)
  await expect(page.getByLabel('Adres strony')).toHaveValue(new RegExp(`^${name.toLowerCase().replaceAll(' ', '-')}(-\\d+)?$`))
  await expect(page.getByRole('navigation', { name: 'Kroki' }).getByText('Płatności')).toHaveCount(0)

  await page.getByLabel('Data', { exact: true }).fill('2026-12-06')
  await page.getByLabel('Start pierwszej konkurencji').fill('10:00')
  await page.getByLabel('Zapisy otwarte od').fill('2026-11-01')
  await page.getByLabel('Zapisy online do').fill('2026-12-03')

  // One keystroke, no lookup: Nominatim is asked on Enter only.
  const town = page.getByLabel('Miejscowość')
  await town.fill('Niebor')
  expect(nominatim.length).toBe(0)
  await town.press('Enter')
  await page.getByTestId('town-candidates').getByRole('button', { name: /Nieborowice/ }).click()
  expect(nominatim.length).toBe(1)
  expect(new URL(nominatim[0]).searchParams.get('countrycodes')).toBe('pl')
  await expect(page.getByTestId('town-area')).toHaveText('GM. PILCHOWICE · ŚLĄSKIE')

  await page.getByLabel('Szczegóły miejsca').fill('Boisko LKS, ul. Szkolna 12.')
  // Ruling P2-R19: the organizer types the contact address; nothing fills it in.
  await expect(page.getByLabel('E-mail kontaktowy organizatora')).toHaveValue('')
  await page.getByLabel('E-mail kontaktowy organizatora').fill('zapisy@zatyrani.example')
  await page.getByLabel('Wydarzenie charytatywne').check()
  await page.getByLabel('Cel', { exact: true }).fill('Leczenie Zuzi')

  // Uploads go through three requests (start, signed PUT, finish); the first
  // call of a function on the local stack boots its worker.
  await page.getByTestId('regulamin-input').setInputFiles({ name: 'regulamin-bieg.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(page.getByTestId('regulamin-file')).toBeVisible({ timeout: 20_000 })
  const poster = await sharp({ create: { width: 2000, height: 2828, channels: 3, background: '#bbdd00' } }).png().toBuffer()
  await page.getByTestId('poster-input').setInputFiles({ name: 'plakat-leszy.png', mimeType: 'image/png', buffer: poster })
  await expect(page.getByTestId('poster-file')).toHaveText('plakat-leszy.png', { timeout: 20_000 })
  await expect(page.getByText('1600×2262 · BEZ GPS')).toBeVisible()

  await expect.poll(async () => {
    const s = await settingsOf(eventId)
    return [s.event_date, s.first_start_time, s.town_label, s.town_area, Number(s.lat), s.place_details, s.is_charity,
      s.charity_goal, s.regulamin_kind, !!s.regulamin_upload_id, !!s.poster_upload_id, !!s.opens_at, !!s.closes_at, s.contact_email]
  }, { timeout: 15_000 }).toEqual(['2026-12-06', '10:00:00', 'Nieborowice', 'GM. PILCHOWICE · ŚLĄSKIE', 50.2381,
    'Boisko LKS, ul. Szkolna 12.', true, 'Leczenie Zuzi', 'pdf', true, true, true, true, 'zapisy@zatyrani.example'])
  await expect(page.getByTestId('save-status')).toContainText('ZAPISANO AUTOMATYCZNIE')

  // Reload mid-wizard: everything comes back from the server.
  await page.reload()
  await expect(page.getByLabel('Data', { exact: true })).toHaveValue('2026-12-06')
  await expect(page.getByLabel('Start pierwszej konkurencji')).toHaveValue('10:00')
  await expect(page.getByLabel('Zapisy otwarte od')).toHaveValue('2026-11-01')
  await expect(page.getByLabel('Zapisy online do')).toHaveValue('2026-12-03')
  await expect(page.getByLabel('Miejscowość')).toHaveValue('Nieborowice')
  await expect(page.getByTestId('town-area')).toHaveText('GM. PILCHOWICE · ŚLĄSKIE')
  await expect(page.getByLabel('Szczegóły miejsca')).toHaveValue('Boisko LKS, ul. Szkolna 12.')
  await expect(page.getByLabel('Wydarzenie charytatywne')).toBeChecked()
  await expect(page.getByLabel('Cel', { exact: true })).toHaveValue('Leczenie Zuzi')
  await expect(page.getByLabel('E-mail kontaktowy organizatora')).toHaveValue('zapisy@zatyrani.example')
  await expect(page.getByTestId('regulamin-file')).toBeVisible()
  await expect(page.getByTestId('poster-file')).toHaveText('plakat-leszy.png')

  // An edit typed just before a reload is not lost: the page asks first
  // (beforeunload) and the save it starts outlives the unload (keepalive).
  const dialogs = []
  page.on('dialog', (d) => { dialogs.push(d.type()); d.accept() })
  await page.getByLabel('Szczegóły miejsca').fill('Boisko LKS, ul. Szkolna 12. Wejście od parku.')
  await page.reload()
  expect(dialogs.every((t) => t === 'beforeunload')).toBe(true)
  await expect.poll(async () => (await settingsOf(eventId)).place_details, { timeout: 15_000 })
    .toBe('Boisko LKS, ul. Szkolna 12. Wejście od parku.')
  await page.reload()
  await expect(page.getByLabel('Szczegóły miejsca')).toHaveValue('Boisko LKS, ul. Szkolna 12. Wejście od parku.')
  page.removeAllListeners('dialog')

  // A2b: Biuro zawodów. Podstawy has no gaps left, so it is ticked.
  await page.getByRole('button', { name: 'Dalej: biuro zawodów' }).click()
  await expect(page).toHaveURL(new RegExp(`/wydarzenia/${eventId}/biuro$`))
  await expect(page.getByRole('heading', { name: 'Biuro zawodów' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Kroki' }).getByRole('link', { name: /Podstawy/ })).toContainText('✓')

  await page.getByLabel('Inne miejsce').check()
  await page.getByLabel('Adres', { exact: true }).fill('Szkoła Podstawowa, ul. Szkolna 4, Nieborowice')
  await page.getByLabel('Uwagi').fill('Pakiet za inną osobę tylko z upoważnieniem.')
  await page.getByRole('button', { name: '+ Termin' }).click()
  await page.getByLabel('Dzień 1').fill('2026-12-05')
  await page.getByLabel('Od 1').fill('17:00')
  await page.getByLabel('Do 1').fill('19:00')
  await page.getByRole('button', { name: '+ Termin' }).click()
  await page.getByLabel('Dzień 2').fill('2026-12-06')
  await page.getByLabel('Od 2').fill('08:00')
  await page.getByLabel('Do 2').fill('09:30')

  await expect.poll(async () => {
    const s = await settingsOf(eventId)
    const { data: hours } = await admin().from('office_hours').select('starts_at').eq('event_id', eventId)
    return [s.office_same_as_event, s.office_address, s.office_notes, s.office_lat != null, hours.length]
  }, { timeout: 15_000 }).toEqual([false, 'Szkoła Podstawowa, ul. Szkolna 4, Nieborowice',
    'Pakiet za inną osobę tylko z upoważnieniem.', true, 2])

  await page.reload()
  await expect(page.getByLabel('Inne miejsce')).toBeChecked()
  await expect(page.getByLabel('Adres', { exact: true })).toHaveValue('Szkoła Podstawowa, ul. Szkolna 4, Nieborowice')
  await expect(page.getByLabel('Uwagi')).toHaveValue('Pakiet za inną osobę tylko z upoważnieniem.')
  await expect(page.getByLabel('Dzień 1')).toHaveValue('2026-12-05')
  await expect(page.getByLabel('Od 1')).toHaveValue('17:00')
  await expect(page.getByLabel('Do 2')).toHaveValue('09:30')

  // A3: Konkurencje. Two competitions, a course for the first; a third one
  // removed again (a draft competition can be deleted).
  await page.getByRole('button', { name: 'Dalej: konkurencje' }).click()
  await expect(page.getByRole('heading', { name: 'Konkurencje' })).toBeVisible()
  await page.getByRole('button', { name: '+ Konkurencja' }).click()
  await page.getByLabel('Nazwa konkurencji 1').fill('Bieg 9 km')
  await page.getByLabel('Dystans 1').fill('9 km')
  await page.getByLabel('Start 1').fill('10:00')
  await page.getByLabel('Limit 1').fill('80')
  await page.getByLabel('Wiek od 1').fill('16')
  await page.getByTestId('competitions').locator('input[type=file]').first().setInputFiles({ name: 'trasa-9km.gpx', mimeType: 'application/gpx+xml', buffer: GPX })
  await expect(page.getByTestId('gpx-ok')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: '+ Konkurencja' }).click()
  await page.getByLabel('Nazwa konkurencji 2').fill('Bieg dzieci')
  await page.getByLabel('Dystans 2').fill('400 m')
  await page.getByLabel('Start 2').fill('11:30')
  await page.getByLabel('Limit 2').fill('20')
  await page.getByLabel('Wiek od 2').fill('4')
  await page.getByLabel('Wiek do 2').fill('9')
  await page.getByLabel('Dzieci 2').check()
  await expect(page.getByTestId('event-capacity')).toHaveText('100 OSÓB')
  await expect(page.getByLabel('Rodzaj 1').locator('option[value=team]')).toBeDisabled()
  await expect(page.getByText('Rośnie z datą zapisu')).toBeVisible()
  await expect(page.getByRole('radio', { name: /Rośnie z datą zapisu/ })).toBeDisabled()
  await page.getByRole('button', { name: '+ Konkurencja' }).click()
  await page.getByLabel('Nazwa konkurencji 3').fill('Do usunięcia')
  // P2-R27: a row that cannot be saved yet keeps the organizer on the step.
  await page.getByRole('button', { name: 'Dalej: kategorie' }).click()
  await expect(page).toHaveURL(new RegExp(`/wydarzenia/${eventId}/konkurencje$`))
  await expect(page.getByTestId('unsaved')).toContainText('Podaj limit miejsc.')
  await page.getByLabel('Limit 3').fill('5')
  await expect.poll(async () => (await competitionsOf(eventId)).map((c) => c.name), { timeout: 15_000 })
    .toEqual(['Bieg 9 km', 'Bieg dzieci', 'Do usunięcia'])
  await page.getByRole('button', { name: 'Usuń konkurencję 3' }).click()
  await expect.poll(async () => (await competitionsOf(eventId)).map((c) => [c.name, c.distance_label, c.start_time,
    c.capacity, c.min_age, c.max_age, c.is_kids, !!c.gpx_upload_id]), { timeout: 15_000 }).toEqual([
    ['Bieg 9 km', '9 km', '10:00:00', 80, 16, null, false, true],
    ['Bieg dzieci', '400 m', '11:30:00', 20, 4, 9, true, false],
  ])
  // Editing a competition the server already has updates it in place.
  const ids = (await competitionsOf(eventId)).map((c) => c.category_id)
  await page.getByLabel('Limit 1').fill('90')
  await expect.poll(async () => (await competitionsOf(eventId)).map((c) => [c.category_id, c.capacity]), { timeout: 15_000 })
    .toEqual([[ids[0], 90], [ids[1], 20]])
  await page.reload()
  await expect(page.getByLabel('Nazwa konkurencji 1')).toHaveValue('Bieg 9 km')
  await expect(page.getByLabel('Limit 1')).toHaveValue('90')
  await expect(page.getByLabel('Wiek do 2')).toHaveValue('9')
  await expect(page.getByLabel('Dzieci 2')).toBeChecked()
  await expect(page.getByTestId('gpx-ok')).toBeVisible()
  await expect(page.getByTestId('event-capacity')).toHaveText('110 OSÓB')

  // A4: Kategorie. Age classes every 10 years, the kids' birth-year groups.
  await page.getByRole('button', { name: 'Dalej: kategorie' }).click()
  await expect(page.getByRole('heading', { name: 'Kategorie' })).toBeVisible()
  await page.getByTestId('add-age-classes').click()
  await expect(page.getByTestId('age-chips').getByText('K16–29')).toBeVisible()
  await expect(page.getByTestId('age-count')).toHaveText('× 1 KONKURENCJA = 10 KLASYFIKACJI')
  // I1: switching back and forth never sends an id the server deleted.
  const ageGroupsOf = async () => (await admin().from('age_groups').select('label').in('category_id', ids)).data.map((g) => g.label).sort()
  await expect.poll(ageGroupsOf, { timeout: 15_000 }).toHaveLength(10)
  await page.getByRole('button', { name: 'Co 5 lat' }).click()
  await expect.poll(async () => (await ageGroupsOf()).includes('K16–24'), { timeout: 15_000 }).toBe(true)
  await page.getByRole('button', { name: 'Co 10 lat' }).click()
  await expect.poll(async () => (await ageGroupsOf()).join(','), { timeout: 15_000 })
    .toBe('K16–29,K30–39,K40–49,K50–59,K60+,M16–29,M30–39,M40–49,M50–59,M60+')
  await expect(page.getByTestId('unsaved')).toHaveCount(0)
  await page.getByRole('button', { name: 'Usuń K60+' }).click()
  await expect(page.getByTestId('age-count')).toHaveText('× 1 KONKURENCJA = 9 KLASYFIKACJI')
  await page.getByTestId('add-kids-groups').click()
  await expect(page.getByTestId('kids-row')).toHaveCount(3)
  await page.getByLabel('Dystans grupy 1').fill('200 m')
  await expect.poll(async () => {
    const { data: ag } = await admin().from('age_groups').select('label').in('category_id', ids)
    const { data: kg } = await admin().from('kids_groups').select('label, birth_year_from, birth_year_to, distance_label')
      .eq('category_id', ids[1]).order('birth_year_from')
    return [ag.length, kg.map((g) => [g.label, g.birth_year_from, g.birth_year_to, g.distance_label])]
  }, { timeout: 15_000 }).toEqual([9, [['2017–2018', 2017, 2018, '200 m'], ['2019–2020', 2019, 2020, null], ['2021–2022', 2021, 2022, null]]])
  await page.reload()
  await expect(page.getByTestId('age-chips').locator('span')).toHaveCount(9)
  await expect(page.getByTestId('age-chips').getByText('K60+')).toHaveCount(0)
  await expect(page.getByLabel('Dystans grupy 1')).toHaveValue('200 m')

  // A4b: Pomiar czasu.
  await page.getByRole('button', { name: 'Dalej: pomiar czasu' }).click()
  await page.getByLabel('Inna firma').check()
  await page.getByLabel('Firma', { exact: true }).fill('Przykładowy Pomiar')
  await page.getByLabel(/Link do wyników · można dodać po zawodach/).fill('https://wyniki.example/bieg')
  await expect.poll(async () => {
    const s = await settingsOf(eventId)
    return [s.timing_mode, s.timing_company, s.results_url]
  }, { timeout: 15_000 }).toEqual(['external', 'Przykładowy Pomiar', 'https://wyniki.example/bieg'])
  await page.reload()
  await expect(page.getByLabel('Inna firma')).toBeChecked()
  await expect(page.getByLabel('Firma', { exact: true })).toHaveValue('Przykładowy Pomiar')

  // A5: Formularz.
  await page.getByRole('button', { name: 'Dalej: formularz' }).click()
  await page.getByRole('group', { name: 'Telefon' }).getByRole('button', { name: 'Wymagane' }).click()
  await page.getByRole('group', { name: 'Klub / drużyna' }).getByRole('button', { name: 'Brak' }).click()
  await page.getByRole('group', { name: 'Start na własną odpowiedzialność' }).getByRole('button', { name: 'Dodaj' }).click()
  await page.getByRole('button', { name: '+ Własna zgoda' }).click()
  await page.getByLabel('Treść zgody 1').fill('Zgadzam się na pomiar czasu chipem.')
  await expect(page.getByRole('button', { name: '+ Własne pytanie' })).toBeDisabled()
  await expect.poll(async () => {
    const s = await settingsOf(eventId)
    const { data: k } = await admin().from('event_consents').select('kind, text').eq('event_id', eventId).order('sort_order')
    return [s.form_fields, k.map((c) => c.text)]
  }, { timeout: 15_000 }).toEqual([
    { phone: 'required', city: 'optional', club: 'off', ice: 'optional' },
    ['Akceptuję regulamin zawodów.', 'Znam informację o danych osobowych.', 'Startuję na własną odpowiedzialność.', 'Zgadzam się na pomiar czasu chipem.'],
  ])
  await page.reload()
  await expect(page.getByRole('group', { name: 'Telefon' }).getByRole('button', { name: 'Wymagane' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('group', { name: 'Start na własną odpowiedzialność' }).getByRole('button', { name: 'Dodaj' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Treść zgody 1')).toHaveValue('Zgadzam się na pomiar czasu chipem.')

  // A5b: Dodatki is listed but not built; „Dalej” goes past it.
  const steps = page.getByRole('navigation', { name: 'Kroki' })
  await expect(steps.getByText('Dodatki')).toBeVisible()
  await expect(steps.getByRole('link', { name: /Dodatki/ })).toHaveCount(0)
  await page.goto(`/klub/zatyrani-test/wydarzenia/${eventId}/dodatki`)
  await expect(page.getByTestId('soon')).toHaveText('wkrótce')
  await page.goto(`/klub/zatyrani-test/wydarzenia/${eventId}/formularz`)

  // A7: Publikacja. Nothing blocks; the kids' course is worth adding.
  await page.getByRole('button', { name: 'Dalej: publikacja' }).click()
  await expect(page.getByTestId('checklist')).toBeVisible()
  await expect(page.getByTestId('blocking-item')).toHaveCount(0)
  await expect(page.getByTestId('missing-item').filter({ hasText: 'Ślad GPX: Bieg dzieci' })).toBeVisible()
  await expect(page.getByText('LINK DZIAŁA TYLKO DLA CZŁONKÓW', { exact: false })).toBeVisible()

  // The runner's view of the draft: the form opens, the submit stays off.
  await page.getByRole('link', { name: 'Podgląd jako zawodnik' }).click()
  await expect(page).toHaveURL(new RegExp(`/wydarzenia/${eventId}/podglad$`))
  await expect(page.getByTestId('registration-event-page')).toContainText(name)
  await expect(page.getByTestId('competition')).toHaveCount(2)
  await page.getByTestId('competition').filter({ hasText: 'Bieg 9 km' }).click()
  await expect(page.getByTestId('registration-form')).toBeVisible()
  await expect(page.getByTestId('registration-submit')).toBeDisabled()
  await page.getByRole('link', { name: 'Wróć do edycji' }).click()

  await page.getByRole('button', { name: 'Opublikuj · zapisy od 1.11' }).click()
  await expect(page.getByTestId('published')).toContainText('OPUBLIKOWANE')
  await expect.poll(async () => (await settingsOf(eventId)).state, { timeout: 15_000 }).toBe('published')

  // Back on the list the event is published.
  await page.getByTestId('event-editor').getByRole('link', { name: 'Wydarzenia', exact: true }).click()
  const card = page.getByTestId('event-card').filter({ hasText: name })
  await expect(card).toContainText('OPUBLIKOWANE')
  await expect(card).toContainText('6.12.2026')
})

// A draft of the seed club, made through the edge functions as the owner.
async function draftEvent() {
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const name = `Bieg W26 ${crypto.randomUUID().slice(0, 6)}`
  const created = await callFn('create-registration-event', owner, { clubId: ZT, name })
  const eventId = created.body.data.eventId
  const save = (section, value) => callFn('save-registration-section', owner, { eventId, section, value })
  await save('basics', { placeDetails: 'Boisko', contactEmail: 'zapisy@zatyrani.example' })
  await save('competitions', {
    pricingMode: 'free',
    items: [{ name: 'Bieg 5 km', kind: 'individual', discipline: 'run', distanceLabel: '5 km', startTime: '10:00', capacity: 40, isKids: false, timed: true }],
  })
  return { eventId, name }
}

test('W-26 admin edits the draft; a member reads it with nothing enabled, no publish and no Zgłoszenia', async ({ actors }) => {
  test.setTimeout(90_000)
  const { eventId, name } = await draftEvent()

  const adm = await actors.admin.newPage()
  await offline(adm)
  await adm.goto(`/klub/zatyrani-test/wydarzenia/${eventId}/konkurencje`)
  await expect(adm.getByLabel('Nazwa konkurencji 1')).toBeEnabled()
  await adm.getByLabel('Nazwa konkurencji 1').fill('Bieg 6 km')
  await expect.poll(async () => (await competitionsOf(eventId)).map((c) => c.name), { timeout: 15_000 }).toEqual(['Bieg 6 km'])
  await adm.goto(`/klub/zatyrani-test/wydarzenia/${eventId}/publikacja`)
  await expect(adm.getByRole('button', { name: /^Opublikuj/ })).toBeVisible()

  const mem = await actors.member.newPage()
  await offline(mem)
  await mem.goto('/klub/zatyrani-test/wydarzenia')
  await mem.getByTestId('event-card').filter({ hasText: name }).getByRole('link', { name: 'Otwórz →' }).click()
  await expect(mem.getByTestId('event-editor')).toBeVisible()
  await expect(mem.getByLabel('Nazwa', { exact: true })).toBeDisabled()
  await expect(mem.getByLabel('E-mail kontaktowy organizatora')).toBeDisabled()
  for (const step of ['konkurencje', 'kategorie', 'pomiar', 'formularz']) {
    await mem.goto(`/klub/zatyrani-test/wydarzenia/${eventId}/${step}`)
    await expect(mem.getByTestId('event-editor')).toBeVisible()
    const enabled = mem.getByTestId('event-editor').locator('input:enabled, select:enabled, textarea:enabled')
    await expect(enabled).toHaveCount(0)
  }
  await expect(mem.getByRole('button', { name: '+ Własna zgoda' })).toBeDisabled()
  await mem.goto(`/klub/zatyrani-test/wydarzenia/${eventId}/publikacja`)
  await expect(mem.getByTestId('checklist')).toBeVisible()
  await expect(mem.getByRole('button', { name: /^Opublikuj/ })).toHaveCount(0)
  // Runner personal data is owner/admin only: there is no „Zgłoszenia” at all.
  await expect(mem.getByRole('tab', { name: 'Zgłoszenia' })).toHaveCount(0)
  await expect(mem.getByText('Zgłoszenia', { exact: true })).toHaveCount(0)
  // The preview is for every member.
  await mem.getByRole('link', { name: 'Podgląd jako zawodnik' }).click()
  await expect(mem.getByTestId('registration-event-page')).toContainText('Bieg 6 km')
})

test('W-26 outsiders: inny-klub admin and the admin of another enabled club get the 404 page', async ({ actors, browser }) => {
  test.setTimeout(90_000)
  const { eventId } = await draftEvent()

  const inny = await actors.innyAdmin.newPage()
  await inny.goto(`/klub/inny-klub/wydarzenia/${eventId}`)
  await expect(inny.getByTestId('event-not-found')).toBeVisible()
  await inny.goto(`/klub/inny-klub/wydarzenia/${eventId}/podglad`)
  await expect(inny.getByTestId('event-not-found')).toBeVisible()
  // Under the seed club's address a non-member never reaches the club area.
  await inny.goto(`/klub/zatyrani-test/wydarzenia/${eventId}`)
  await expect(inny).toHaveURL(/\/profil\/klub$/)
  await expect(inny.getByTestId('event-editor')).toHaveCount(0)

  // No agreement needed to read; makeClub cannot load the Deno-side version here.
  const other = await makeClub({ slug: 'drugi-klub-w26', agreement: false })
  const { token } = await sessionFor(other.adminEmail)
  const context = await browser.newContext()
  await context.addCookies([{ name: 'leszy_session', value: token, domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }])
  const page = await context.newPage()
  await page.goto(`/klub/drugi-klub-w26/wydarzenia/${eventId}/konkurencje`)
  await expect(page.getByTestId('event-not-found')).toBeVisible()
  await page.goto(`/klub/drugi-klub-w26/wydarzenia/${eventId}/podglad`)
  await expect(page.getByTestId('event-not-found')).toBeVisible()
  await context.close()
})

test('W-52 after publish Konkurencje sends every competition, hidden ones included; no delete; locks only with entries', async ({ actors }) => {
  test.setTimeout(90_000)
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const { eventId, categoryIds } = await createPublishedFreeEvent(owner, {
    competitions: [
      { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 },
      { name: 'Marsz 5 km', discipline: 'nw', distanceLabel: '5 km', startTime: '10:05', capacity: 30 },
      { name: 'Bieg 3 km', discipline: 'run', distanceLabel: '3 km', startTime: '10:10', capacity: 20 },
    ],
  })
  // Marsz is already hidden; Bieg 3 km has two entries.
  await admin().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', categoryIds[1])
  await admin().from('competitions').update({ taken: 2 }).eq('category_id', categoryIds[2])

  const page = await actors.owner.newPage()
  await offline(page)
  await page.goto(`/klub/zatyrani-test/wydarzenia/${eventId}/konkurencje`)
  const rows = page.getByTestId('competition-row')
  await expect(rows).toHaveCount(3)
  await expect(page.getByRole('button', { name: /Usuń konkurencję/ })).toHaveCount(0)
  await expect(rows.nth(0).getByRole('button', { name: 'Ukryj konkurencję' })).toBeVisible()
  await expect(rows.nth(0).getByTestId('capacity-min')).toHaveCount(0)
  await expect(rows.nth(0).getByRole('img', { name: /rodzaju nie można zmienić/ })).toHaveCount(0)
  await expect(rows.nth(1).getByTestId('hidden-tag')).toHaveText('Ukryta')
  await expect(rows.nth(1).getByRole('button', { name: 'Pokaż konkurencję' })).toBeVisible()
  await expect(rows.nth(2).getByTestId('capacity-min')).toHaveText('MIN. 2')
  await expect(rows.nth(2).getByRole('img', { name: /rodzaju nie można zmienić/ })).toBeVisible()
  await expect(rows.nth(2).getByRole('button', { name: /konkurencję/ })).toHaveCount(0)
  await expect(page.getByTestId('event-capacity')).toHaveText('70 OSÓB')

  const staged = async () => {
    const { data } = await admin().from('registration_pending_changes').select('payload').eq('event_id', eventId).maybeSingle()
    return (data?.payload?.competitions?.items ?? []).map((i) => [i.category_id, i.start_time, i.hidden])
  }
  await page.getByLabel('Start 1').fill('10:15')
  await expect.poll(staged, { timeout: 15_000 }).toEqual([
    [categoryIds[0], '10:15', false], [categoryIds[1], '10:05', true], [categoryIds[2], '10:10', false],
  ])
  await rows.nth(1).getByRole('button', { name: 'Pokaż konkurencję' }).click()
  await expect.poll(staged, { timeout: 15_000 }).toEqual([
    [categoryIds[0], '10:15', false], [categoryIds[1], '10:05', false], [categoryIds[2], '10:10', false],
  ])
})

test('W-55 after publish a staged change is what the step shows, after leaving it and after a reload, and a further edit keeps it', async ({ actors }) => {
  test.setTimeout(90_000)
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const { eventId, categoryIds } = await createPublishedFreeEvent(owner)
  const staged = async () => {
    const { data } = await admin().from('registration_pending_changes').select('payload').eq('event_id', eventId).maybeSingle()
    return {
      items: (data?.payload?.competitions?.items ?? []).map((i) => [i.category_id, i.start_time, i.capacity]),
      place: data?.payload?.basics?.place_details ?? null,
    }
  }
  const page = await actors.owner.newPage()
  await offline(page)
  await page.goto(`/klub/zatyrani-test/wydarzenia/${eventId}/konkurencje`)
  await page.getByLabel('Start 1').fill('10:15')
  await expect.poll(async () => (await staged()).items, { timeout: 15_000 }).toEqual([[categoryIds[0], '10:15', 50]])

  // Leave the tab and come back: the step remounts from the staged value.
  const steps = page.getByRole('tablist', { name: 'Zakładki' })
  await steps.getByRole('tab', { name: /Podstawy/ }).click()
  await page.getByLabel('Szczegóły miejsca').fill('Hala sportowa')
  await expect.poll(async () => (await staged()).place, { timeout: 15_000 }).toBe('Hala sportowa')
  await steps.getByRole('tab', { name: /Konkurencje/ }).click()
  await expect(page.getByLabel('Start 1')).toHaveValue('10:15')

  await page.reload()
  await expect(page.getByLabel('Start 1')).toHaveValue('10:15')
  await page.getByLabel('Limit 1').fill('60')
  await expect.poll(staged, { timeout: 15_000 }).toEqual({ items: [[categoryIds[0], '10:15', 60]], place: 'Hala sportowa' })
  await steps.getByRole('tab', { name: /Podstawy/ }).click()
  await expect(page.getByLabel('Szczegóły miejsca')).toHaveValue('Hala sportowa')
  // Nothing was published: the live competition still starts at 10:00.
  const { data: live } = await admin().from('competitions').select('start_time').eq('category_id', categoryIds[0]).single()
  expect(live.start_time).toBe('10:00:00')
})

// One confirmed runner, through the same RPC register-free uses.
async function registerRunner(eventId, categoryId, email) {
  const { data: consents, error: cErr } = await admin().from('event_consents').select('id').eq('event_id', eventId)
  if (cErr) throw cErr
  const { error } = await admin().rpc('register_free', {
    p_category_id: categoryId,
    p_people: [{ firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-01-01', gender: 'K', email, ageGroupLabel: 'K open' }],
    p_profile_id: null,
    p_meta: { consentIds: consents.map((c) => c.id), ip: null, userAgent: 'test' },
  })
  if (error) throw new Error(`register_free: ${error.message}`)
}

async function pendingPayload(eventId) {
  const { data } = await admin().from('registration_pending_changes').select('payload').eq('event_id', eventId).maybeSingle()
  return data?.payload ?? null
}

test('W-63 after publish a consent somebody accepted is read-only with no delete; one nobody accepted stays editable', async ({ actors }) => {
  test.setTimeout(90_000)
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const { eventId, categoryIds } = await createPublishedFreeEvent(owner)
  const insert = async (text, sortOrder) => {
    const { error } = await admin().from('event_consents').insert({ event_id: eventId, kind: 'custom', text, sort_order: sortOrder })
    if (error) throw error
  }
  await insert('Startuję na własną odpowiedzialność.', 2)
  await insert('Zgadzam się na pomiar czasu chipem.', 3)
  await registerRunner(eventId, categoryIds[0], `w63-${crypto.randomBytes(4).toString('hex')}@test.local`)
  await insert('Zgoda dodana po zapisie.', 4)

  const page = await actors.owner.newPage()
  await offline(page)
  await page.goto(`/klub/zatyrani-test/wydarzenia/${eventId}/formularz`)
  const preset = page.getByRole('group', { name: 'Start na własną odpowiedzialność' })
  await expect(preset.getByRole('button', { name: 'Dodaj' })).toHaveAttribute('aria-pressed', 'true')
  await expect(preset.getByRole('button', { name: 'Nie' })).toBeDisabled()
  const rows = page.getByTestId('custom-consent')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0).getByTestId('consent-locked-text')).toHaveText('Zgadzam się na pomiar czasu chipem.')
  await expect(rows.nth(0).getByRole('textbox')).toHaveCount(0)
  await expect(rows.nth(0).getByRole('button', { name: /Usuń zgodę/ })).toHaveCount(0)
  await expect(rows.nth(0).getByRole('img', { name: /zaakceptowali/i })).toBeVisible()
  await expect(rows.nth(1).getByRole('textbox')).toHaveValue('Zgoda dodana po zapisie.')

  // Deleting the one nobody accepted stages a list that still holds the accepted two.
  await rows.nth(1).getByRole('button', { name: /Usuń zgodę/ }).click()
  await expect.poll(async () => ((await pendingPayload(eventId))?.form?.consents ?? []).map((k) => k.text), { timeout: 15_000 })
    .toEqual(['Startuję na własną odpowiedzialność.', 'Zgadzam się na pomiar czasu chipem.'])
})

test('W-27 after publish the owner moves Bieg 9 km to 10:15, sees the pending bar, publishes from A8a with the box unchecked; a notice reports whom it reached', async ({ actors }) => {
  test.setTimeout(120_000)
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const { eventId, slug, categoryIds } = await createPublishedFreeEvent(owner)
  const runner = `runner-w27-${crypto.randomUUID().slice(0, 8)}@test.local`
  await registerRunner(eventId, categoryIds[0], runner)
  await clearMessages()

  const page = await actors.owner.newPage()
  await offline(page)
  await page.goto(`/klub/zatyrani-test/wydarzenia/${eventId}/konkurencje`)
  await expect(page.getByTestId('pending-bar')).toHaveCount(0)
  await page.getByLabel('Start 1').fill('10:15')
  const bar = page.getByTestId('pending-bar')
  await expect(bar).toContainText('Niezapisane zmiany: 1', { timeout: 15_000 })
  await expect(bar).toContainText('Bieg 9 km: godzina startu')
  await expect(bar.getByRole('link', { name: 'Podgląd' })).toHaveAttribute('href', `/klub/zatyrani-test/wydarzenia/${eventId}/podglad`)

  // A8a: the row before → after, the notice offered but not ticked.
  await bar.getByRole('button', { name: 'Opublikuj zmiany' }).click()
  const dialog = page.getByRole('dialog', { name: 'Opublikować zmiany?' })
  await expect(dialog).toBeVisible()
  const row = dialog.getByTestId('change-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Bieg 9 km: godzina startu')
  await expect(row.getByTestId('change-before')).toHaveText('10:00')
  await expect(row.getByTestId('change-after')).toHaveText('10:15')
  const notify = dialog.getByRole('checkbox', { name: /Powiadom mailem zapisanych na Bieg 9 km · 1 osoba/ })
  await expect(notify).not.toBeChecked()
  await expect(dialog.getByLabel('Temat')).toHaveCount(0)
  await expect(dialog.getByLabel('Treść')).toHaveCount(0)
  // Ticked, the e-mail is shown and editable; unticked again, it goes away.
  await notify.check()
  await expect(dialog.getByLabel('Temat')).toHaveValue(/: zmiany$/)
  await expect(dialog.getByLabel('Treść')).toHaveValue(/Bieg 9 km: godzina startu: 10:00 → 10:15/)
  await expect(dialog.getByRole('button', { name: 'Opublikuj i wyślij' })).toBeVisible()
  await notify.uncheck()
  await expect(dialog.getByLabel('Temat')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Opublikuj', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('changes-result')).toHaveText('Opublikowano zmiany.')
  await expect(page.getByTestId('pending-bar')).toHaveCount(0)
  expect(await messagesTo(runner)).toHaveLength(0)

  // The runner's page shows the new time after a reload.
  const viewer = await actors.viewer.newPage()
  await offline(viewer)
  await viewer.goto(`/events/${slug}`)
  await viewer.reload()
  await expect(viewer.getByTestId('competition').filter({ hasText: 'Bieg 9 km' })).toContainText('start 10:15')

  // With the box ticked the result says how many were told.
  await page.getByLabel('Start 1').fill('10:20')
  await expect(page.getByTestId('pending-bar')).toContainText('Niezapisane zmiany: 1', { timeout: 15_000 })
  await page.getByTestId('pending-bar').getByRole('button', { name: 'Opublikuj zmiany' }).click()
  await dialog.getByRole('checkbox', { name: /Powiadom mailem/ }).check()
  await dialog.getByLabel('Temat').fill('Bieg 9 km: start 10:20')
  await dialog.getByRole('button', { name: 'Opublikuj i wyślij' }).click()
  await expect(page.getByTestId('changes-result')).toHaveText('Opublikowano zmiany. Powiadomiono 1 osobę.')
  await expect.poll(async () => (await messagesTo(runner)).map((m) => m.subject), { timeout: 15_000 }).toEqual(['Bieg 9 km: start 10:20'])
})

test('W-57 „Odrzuć” drops the staged change, and the next edit of the same step does not bring it back', async ({ actors }) => {
  test.setTimeout(90_000)
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const { eventId, categoryIds } = await createPublishedFreeEvent(owner)
  const page = await actors.owner.newPage()
  await offline(page)
  await page.goto(`/klub/zatyrani-test/wydarzenia/${eventId}/konkurencje`)
  await page.getByLabel('Start 1').fill('10:15')
  const bar = page.getByTestId('pending-bar')
  await expect(bar).toContainText('Niezapisane zmiany: 1', { timeout: 15_000 })

  await bar.getByRole('button', { name: 'Odrzuć' }).click()
  await bar.getByRole('button', { name: 'Tak, odrzuć' }).click()
  await expect(page.getByTestId('pending-bar')).toHaveCount(0)
  await expect.poll(() => pendingPayload(eventId), { timeout: 15_000 }).toBeNull()
  await expect(page.getByLabel('Start 1')).toHaveValue('10:00')

  // Another field of the same section: only that change is staged.
  await page.getByLabel('Limit 1').fill('60')
  await expect.poll(async () => (await pendingPayload(eventId))?.competitions?.items?.map((i) => [i.category_id, i.start_time, i.capacity]),
    { timeout: 15_000 }).toEqual([[categoryIds[0], '10:00', 60]])
  await expect(bar).toContainText('Niezapisane zmiany: 1')
  await expect(bar).toContainText('Bieg 9 km: limit miejsc')
  await page.reload()
  await expect(page.getByLabel('Start 1')).toHaveValue('10:00')
  await expect(page.getByLabel('Limit 1')).toHaveValue('60')
})

test('W-58 the „Nie zapisano” alert of a refused tab change goes once the input is valid', async ({ actors }) => {
  test.setTimeout(90_000)
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const { eventId } = await createPublishedFreeEvent(owner)
  const page = await actors.owner.newPage()
  await offline(page)
  await page.goto(`/klub/zatyrani-test/wydarzenia/${eventId}/konkurencje`)
  await page.getByLabel('Limit 1').fill('')
  await page.getByRole('tablist', { name: 'Zakładki' }).getByRole('tab', { name: /Podstawy/ }).click()
  await expect(page).toHaveURL(/\/konkurencje$/)
  await expect(page.getByTestId('unsaved')).toContainText('Podaj limit miejsc.')
  await page.getByLabel('Limit 1').fill('45')
  await expect(page.getByTestId('unsaved')).toHaveCount(0)
})

test('W-61 „Odrzuć” after a failed save (I1): the value that failed is dropped with the rest, and the editor moves on', async ({ actors }) => {
  test.setTimeout(90_000)
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const { eventId } = await createPublishedFreeEvent(owner)
  const page = await actors.owner.newPage()
  await offline(page)
  await page.goto(`/klub/zatyrani-test/wydarzenia/${eventId}/konkurencje`)
  await page.getByLabel('Limit 1').fill('60')
  const bar = page.getByTestId('pending-bar')
  await expect(bar).toContainText('Niezapisane zmiany: 1', { timeout: 15_000 })

  // The next save fails (server error): its value stays queued for a retry.
  await page.route('**/save-registration-section', (route) => route.fulfill({ status: 500, json: { error: 'Internal server error' } }))
  await page.getByLabel('Start 1').fill('10:15')
  await expect(page.getByTestId('save-status')).toContainText('NIE ZAPISANO', { timeout: 15_000 })

  await bar.getByRole('button', { name: 'Odrzuć' }).click()
  await bar.getByRole('button', { name: 'Tak, odrzuć' }).click()
  await expect(page.getByTestId('pending-bar')).toHaveCount(0)
  await page.unroute('**/save-registration-section')
  await expect(page.getByLabel('Start 1')).toHaveValue('10:00')
  await expect(page.getByLabel('Limit 1')).toHaveValue('50')
  await expect(page.getByTestId('save-status')).not.toContainText('NIE ZAPISANO')

  // A tab change saves what is queued: nothing, so it goes through and nothing is staged.
  await page.getByRole('tablist', { name: 'Zakładki' }).getByRole('tab', { name: /Podstawy/ }).click()
  await expect(page).toHaveURL(/\/podstawy$/)
  await page.waitForTimeout(3000)
  expect(await pendingPayload(eventId)).toBeNull()
})

test('W-62 A8a publishes only what it showed (P2-R28): staged again meanwhile, it shows the new rows and asks again; Tab stays inside', async ({ actors }) => {
  test.setTimeout(90_000)
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const { eventId, categoryIds } = await createPublishedFreeEvent(owner)
  const page = await actors.owner.newPage()
  await offline(page)
  await page.goto(`/klub/zatyrani-test/wydarzenia/${eventId}/konkurencje`)
  await page.getByLabel('Start 1').fill('10:15')
  const bar = page.getByTestId('pending-bar')
  await expect(bar).toContainText('Niezapisane zmiany: 1', { timeout: 15_000 })
  await bar.getByRole('button', { name: 'Opublikuj zmiany' }).click()
  const dialog = page.getByRole('dialog', { name: 'Opublikować zmiany?' })
  await expect(dialog.getByTestId('change-row')).toHaveCount(1)

  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }

  // Another admin stages a place change while the dialog is open.
  const r = await callFn('save-registration-section', owner, { eventId, section: 'basics', value: { placeDetails: 'Hala sportowa' } })
  expect(r.status).toBe(200)
  await dialog.getByRole('button', { name: 'Opublikuj', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Zmiany zmieniły się od podglądu. Sprawdź je jeszcze raz.')
  await expect(dialog.getByTestId('change-row')).toHaveCount(2)
  await expect(dialog.getByTestId('change-row').filter({ hasText: 'Miejsce startu' })).toContainText('Hala sportowa')
  const { data: live } = await admin().from('competitions').select('start_time').eq('category_id', categoryIds[0]).single()
  expect(live.start_time).toBe('10:00:00')

  await dialog.getByRole('button', { name: 'Opublikuj', exact: true }).click()
  await expect(page.getByTestId('changes-result')).toHaveText('Opublikowano zmiany.')
  expect((await settingsOf(eventId)).place_details).toBe('Hala sportowa')
})
