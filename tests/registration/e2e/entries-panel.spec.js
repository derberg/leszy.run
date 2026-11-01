import fs from 'node:fs/promises'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import { attemptFor, confirmOk, orderOk, paidOrderOk, person, runnerEmail } from '../helpers/orders.js'

// Plan 6 task 6a: the organizer's entries panel (B3) in Zgłoszenia: the tiles, the competition and
// status chips, the search, the CSV and the ⋯ menu. O-50…O-53 in docs/registration/scenario-matrix.md.

const ZT = '00000000-0000-4000-8000-0000000000c1'
const BIEG9 = { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 2 }
const BIEG5 = { name: 'Bieg 5 km', discipline: 'run', distanceLabel: '5 km', startTime: '11:00', capacity: 20 }
const STAFETA = { name: 'Sztafeta', discipline: 'run', distanceLabel: '4 x 5 km', startTime: '12:00', capacity: 10, kind: 'team', teamMin: 2, teamMax: 5 }

let owner
let captain
let event
let teamId

const zgloszenia = (eventId) => `/klub/zatyrani-test/wydarzenia/${eventId}/zgloszenia`

async function open(context, width, path) {
  const page = await context.newPage()
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  await page.setViewportSize({ width, height: 900 })
  await page.goto(path)
  return page
}

const member = (over) => ({ lastName: 'Leśny', birthDate: '1987-01-01', gender: 'M', phone: '600300400', ...over })

// One paid event: Bieg 9 km full (2 of 2 paid) with one more order unpaid, Bieg 5 km with Anna
// Wiśniewska paid, a paid team of 4 in Sztafeta whose 3 added members have not accepted yet.
async function seed() {
  const e = await createPublishedPaidEvent(owner, {
    competitions: [BIEG9, BIEG5, STAFETA], prices: { 'Bieg 9 km': 6000, 'Bieg 5 km': 4000, Sztafeta: 24000 },
  })
  const [c9, c5] = e.categoryIds
  const one = (categoryId, firstName, lastName) => ({ categoryId, people: [person(runnerEmail(lastName.toLowerCase()), { firstName, lastName })] })
  // The unpaid order first: since P3-R15 it holds no place, so the competition fills after it.
  await orderOk(e, one(c9, 'Piotr', 'Zieliński'))
  await paidOrderOk(e, one(c9, 'Jan', 'Kowalski'))
  await paidOrderOk(e, one(c9, 'Ewa', 'Nowak'))
  await paidOrderOk(e, one(c5, 'Anna', 'Wiśniewska'))

  const { data: consents } = await admin().from('event_consents').select('id').eq('event_id', e.eventId)
  const r = await callFn('register-team', captain, {
    categoryId: e.categoryIds[2], teamName: 'Wilcze Stado',
    members: [
      { person: member({ firstName: 'Ola', lastName: 'Leśna', birthDate: '1988-03-01', gender: 'K', email: ACTOR_EMAILS.runner }) },
      { person: member({ firstName: 'Piotr', email: runnerEmail('piotr') }) },
      { person: member({ firstName: 'Ewa', gender: 'K', email: runnerEmail('ewa') }) },
      { person: member({ firstName: 'Jan', email: runnerEmail('jan') }) },
    ],
    membersConsent: true, acceptedConsentIds: consents.map((c) => c.id), serviceRegulamin: true, displayedTotal: 24000,
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  const att = await attemptFor(r.body.data.orderId, 24000)
  await confirmOk(r.body.data.orderId, att.txn, 24000)
  teamId = r.body.data.teamId
  return e
}

test.beforeAll(async () => {
  owner = await sessionFor(ACTOR_EMAILS.owner)
  captain = await sessionFor(ACTOR_EMAILS.runner)
  const status = await callFn('organizer-status', owner, { clubId: ZT })
  if (!status.body.data.agreementAccepted) {
    await callFn('accept-organizer-agreement', owner, { clubId: ZT, version: status.body.data.version })
  }
  await resetThrottle()
  event = await seed()
})
test.beforeEach(async () => { await resetThrottle() })

const personRows = (page) => page.getByTestId('registrations').getByTestId('registration-row')

test('O-50 the owner reads the tiles and chips of the seeded entries, filters by competition and „Czeka na wpłatę”, finds „wiśniewska”', async ({ actors }) => {
  const page = await open(actors.owner, 1440, zgloszenia(event.eventId))
  const actions = page.getByTestId('entries-actions')
  await expect(actions.getByRole('button', { name: 'Wiadomość do uczestników' })).toBeVisible()
  await expect(actions.getByRole('button', { name: 'Eksport CSV' })).toBeVisible()

  // Confirmed entries only (= taken): 2 + 1 people of 22 places, 1 team of 10, never one sum.
  await expect(page.getByTestId('tile-listed')).toHaveText('NA LIŚCIE3 / 22 · 1 / 10 DRUŻYN')
  // Bieg 9 km is full and Piotr's order is unpaid.
  await expect(page.getByTestId('tile-awaiting')).toHaveText('CZEKA NA WPŁATĘ1 · BRAK MIEJSC')
  await expect(page.getByTestId('tile-consent')).toHaveText('CZEKA NA ZGODY3')
  await expect(page.getByTestId('tile-income')).toHaveText('WPŁYWY DLA KLUBU400,00 zł')

  const comps = page.getByTestId('competition-chips')
  await expect(comps.getByRole('button')).toHaveText(['Wszystkie · 8', 'Bieg 9 km · 3', 'Bieg 5 km · 1', 'Sztafeta · 1 drużyna'])
  const statuses = page.getByTestId('status-chips')
  // „Do wycofania w pomiarze” only once somebody is to be withdrawn.
  await expect(statuses.getByRole('button')).toHaveText([
    'Wszystkie', 'Opłacone · 7', 'Czeka na wpłatę · 1', 'Czeka na zgody · 3', 'Wygasłe · 0', 'Anulowane · 0',
  ])

  const table = page.getByTestId('registrations')
  await expect(table.locator('thead th')).toHaveText(['Nr', 'Zawodnik / drużyna', 'Konkurencja', 'Status', 'Wpłata', 'Akcje'])
  await expect(personRows(page)).toHaveCount(4)
  const team = table.getByTestId('team-row')
  await expect(team).toContainText('Wilcze Stado · 4 os.')
  await expect(team).toContainText('kapitan: Ola Leśna')
  await expect(team).toContainText('ZGODY 1/4')
  await expect(team).toContainText('240,00 zł')
  const piotr = personRows(page).filter({ hasText: 'Piotr Zieliński' })
  await expect(piotr).toContainText(/CZEKA NA WPŁATĘ · DO \d+\.\d\d/)
  await expect(personRows(page).filter({ hasText: 'Jan Kowalski' })).toContainText('OPŁACONE')
  await expect(personRows(page).filter({ hasText: 'Jan Kowalski' })).toContainText('60,00 zł')

  await comps.getByRole('button', { name: 'Bieg 9 km · 3' }).click()
  await expect(comps.getByRole('button', { name: 'Bieg 9 km · 3' })).toHaveAttribute('aria-pressed', 'true')
  await expect(personRows(page)).toHaveText([/Piotr Zieliński/, /Jan Kowalski/, /Ewa Nowak/])
  await expect(table.getByTestId('team-row')).toHaveCount(0)
  await statuses.getByRole('button', { name: 'Czeka na wpłatę · 1' }).click()
  await expect(personRows(page)).toHaveText([/Piotr Zieliński/])

  await comps.getByRole('button', { name: 'Wszystkie · 8' }).click()
  await statuses.getByRole('button', { name: 'Wszystkie', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Szukaj' }).fill('wiśniewska')
  await expect(personRows(page)).toHaveText([/Anna Wiśniewska/])
  await expect(table.getByTestId('team-row')).toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Szukaj' }).fill('')

  // „Czeka na zgody” opens the team to the three who have not accepted.
  await statuses.getByRole('button', { name: 'Czeka na zgody · 3' }).click()
  await expect(table.getByTestId('team-row')).toHaveCount(1)
  await expect(table.getByTestId('team-member')).toHaveCount(3)
})

test('O-50 ⋯ offers what each row allows; „Przypomnij o wpłacie” answers with the server\'s refusal', async ({ actors }) => {
  const page = await open(actors.owner, 1440, zgloszenia(event.eventId))
  const items = async (name) => {
    await page.getByRole('button', { name: `Akcje — ${name}` }).first().click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const labels = await menu.getByRole('menuitem').allTextContents()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    return labels
  }
  expect(await items('Jan Kowalski')).toEqual(['Edytuj dane', 'Napisz do zawodnika', 'Zwróć wpłatę', 'Anuluj zgłoszenie'])
  expect(await items('Piotr Zieliński')).toEqual([
    'Edytuj dane', 'Przypomnij o wpłacie', 'Przedłuż termin wpłaty', 'Napisz do zawodnika', 'Anuluj nieopłacone zgłoszenie',
  ])
  expect(await items('Wilcze Stado')).toEqual([
    'Napisz do kapitana', 'Zwróć wpłatę', 'Anuluj zgłoszenie', 'Zmień nazwę drużyny', 'Skład drużyny',
  ])
  await page.getByRole('button', { name: 'Akcje — Wilcze Stado' }).click()
  await expect(page.getByRole('menuitem', { name: 'Skład drużyny' }))
    .toHaveAttribute('href', `/events/${event.slug}/druzyna/${teamId}`)
  await page.keyboard.press('Escape')

  // A member still waiting keeps Plan 4's two consent actions, now in the menu.
  await page.getByRole('button', { name: 'Skład — Wilcze Stado' }).click()
  expect(await items('Piotr Leśny')).toEqual([
    'Edytuj dane', 'Przypomnij o akceptacji regulaminu', 'Regulamin podpisany w biurze', 'Napisz do zawodnika', 'Anuluj zgłoszenie',
  ])

  // Bieg 9 km is full: the server refuses a reminder nobody could pay (D6-27).
  await page.getByRole('button', { name: 'Akcje — Piotr Zieliński' }).click()
  await page.getByRole('menuitem', { name: 'Przypomnij o wpłacie' }).click()
  await expect(page.getByTestId('entries-notice')).toHaveText('Brak wolnych miejsc w tej konkurencji.')
})

test('O-51 „Eksport CSV” downloads the filtered rows with the BOM and the header', async ({ actors }) => {
  const page = await open(actors.owner, 1440, zgloszenia(event.eventId))
  await page.getByTestId('competition-chips').getByRole('button', { name: 'Bieg 9 km · 3' }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Eksport CSV' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(new RegExp(`^zgloszenia-${event.slug}-\\d{4}-\\d\\d-\\d\\d\\.csv$`))
  const bytes = await fs.readFile(await download.path())
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  const lines = bytes.toString('utf8').slice(1).split('\r\n')
  expect(lines[0]).toMatch(/^"Nr";"Imię";"Nazwisko";"Data urodzenia";"Płeć";"Kategoria";"Konkurencja";/)
  // The chip narrows the export as it narrows the list.
  expect(lines).toHaveLength(4)
  expect(lines.slice(1).join('\n')).not.toContain('Wiśniewska')
})

test('O-52 a member sent to …/zgloszenia lands on Podstawy, has no „Zgłoszenia” tab and gets no rows', async ({ actors }) => {
  const page = await actors.member.newPage()
  const answers = []
  page.on('response', async (res) => {
    if (!res.url().endsWith('/list-event-registrations')) return
    answers.push({ status: res.status(), rows: (await res.json().catch(() => ({}))).data?.length ?? 0 })
  })
  const base = `/klub/zatyrani-test/wydarzenia/${event.eventId}`
  await page.goto(`${base}/zgloszenia`)
  await expect(page).toHaveURL(new RegExp(`${base}/podstawy$`))
  await expect(page.getByRole('tab', { name: 'Zgłoszenia' })).toHaveCount(0)
  await expect(page.getByTestId('registrations')).toHaveCount(0)
  await expect(page.getByTestId('tile-listed')).toHaveCount(0)
  expect(answers.filter((a) => a.status === 200 || a.rows > 0)).toEqual([])
})

test('O-53 at 390 px every entry is a card, nothing scrolls sideways and no button wraps, the ⋯ menu open too', async ({ actors }) => {
  const page = await open(actors.owner, 390, zgloszenia(event.eventId))
  const cards = page.getByTestId('registrations-cards')
  await expect(cards.getByTestId('registration-card')).toHaveCount(4)
  await expect(cards.getByTestId('team-row')).toHaveCount(1)
  await expect(page.getByTestId('registrations')).toBeHidden()

  const wrapped = () => page.locator('button:visible, a[role="menuitem"]:visible').evaluateAll((els) => els.filter((e) => {
    const s = getComputedStyle(e)
    const line = Number.parseFloat(s.lineHeight) || Number.parseFloat(s.fontSize) * 1.5
    const chrome = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((n, k) => n + Number.parseFloat(s[k]), 0)
    const single = Math.max(Number.parseFloat(s.minHeight) || 0, line + chrome)
    return e.getBoundingClientRect().height > single + 1 || e.scrollWidth > e.clientWidth + 1
  }).map((e) => e.textContent))
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

  expect(await wrapped()).toEqual([])
  expect(await sideways()).toBe(true)
  await cards.getByRole('button', { name: 'Akcje — Piotr Zieliński' }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  expect(await wrapped()).toEqual([])
  expect(await sideways()).toBe(true)
  const box = await page.getByRole('menu').boundingBox()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await page.keyboard.press('Escape')
  await cards.getByRole('button', { name: 'Akcje — Wilcze Stado' }).click()
  expect(await wrapped()).toEqual([])
})
