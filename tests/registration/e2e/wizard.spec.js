import crypto from 'node:crypto'
import sharp from 'sharp'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, localEnv, sessionFor } from '../helpers/stack.js'

// Plan 2 task 8: the organizer wizard. W-25 (owner, up to Biuro zawodów here;
// the remaining steps, preview and publish join it with the rest of the wizard).
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

test('W-25 owner creates an event, fills Podstawy and Biuro zawodów, and a reload finds every value', async ({ actors }) => {
  test.setTimeout(90_000)
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
  await page.getByLabel('Wydarzenie charytatywne').check()
  await page.getByLabel('Cel', { exact: true }).fill('Leczenie Zuzi')

  await page.getByTestId('regulamin-input').setInputFiles({ name: 'regulamin-bieg.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(page.getByTestId('regulamin-file')).toBeVisible()
  const poster = await sharp({ create: { width: 2000, height: 2828, channels: 3, background: '#bbdd00' } }).png().toBuffer()
  await page.getByTestId('poster-input').setInputFiles({ name: 'plakat-leszy.png', mimeType: 'image/png', buffer: poster })
  await expect(page.getByTestId('poster-file')).toHaveText('plakat-leszy.png')
  await expect(page.getByText('1600×2262 · BEZ GPS')).toBeVisible()

  await expect.poll(async () => {
    const s = await settingsOf(eventId)
    return [s.event_date, s.first_start_time, s.town_label, s.town_area, Number(s.lat), s.place_details, s.is_charity,
      s.charity_goal, s.regulamin_kind, !!s.regulamin_upload_id, !!s.poster_upload_id, !!s.opens_at, !!s.closes_at]
  }, { timeout: 15_000 }).toEqual(['2026-12-06', '10:00:00', 'Nieborowice', 'GM. PILCHOWICE · ŚLĄSKIE', 50.2381,
    'Boisko LKS, ul. Szkolna 12.', true, 'Leczenie Zuzi', 'pdf', true, true, true, true])
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
  await expect(page.getByTestId('regulamin-file')).toBeVisible()
  await expect(page.getByTestId('poster-file')).toHaveText('plakat-leszy.png')

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

  // Back on the list the draft is there.
  await page.getByTestId('event-editor').getByRole('link', { name: 'Wydarzenia', exact: true }).click()
  const card = page.getByTestId('event-card').filter({ hasText: name })
  await expect(card).toContainText('SZKIC')
  await expect(card).toContainText('6.12.2026')
  await expect(card.getByRole('link', { name: 'Dokończ konfigurację →' })).toBeVisible()
})
