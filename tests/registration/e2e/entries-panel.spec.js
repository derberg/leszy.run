import fs from 'node:fs/promises'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedPaidEvent } from '../helpers/registrationFixtures.js'
import {
  attemptFor, confirmOk, minutesFromNow, orderOf, orderOk, paidOrderOk, person, rows, runnerEmail, setSettings,
} from '../helpers/orders.js'
import { dpayMode, dpayRefunds, dpayReset, payMock } from '../helpers/dpayControl.js'
import { messagesTo } from '../helpers/emailCapture.js'

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

test('O-50 ⋯ offers what each row allows; no „Przypomnij o wpłacie” in a full competition', async ({ actors }) => {
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
  // Plan 7: „Przekaż pakiet” on a confirmed adult's own row; no „Partner” while the event has none.
  expect(await items('Jan Kowalski')).toEqual(['Edytuj dane', 'Napisz do zawodnika', 'Przekaż pakiet', 'Zwróć wpłatę', 'Anuluj zgłoszenie'])
  // Bieg 9 km is full: the server would refuse a reminder nobody could pay (D6-27), so ⋯ has none.
  expect(await items('Piotr Zieliński')).toEqual([
    'Edytuj dane', 'Przedłuż termin wpłaty', 'Napisz do zawodnika', 'Anuluj nieopłacone zgłoszenie',
  ])
  // Cancelling the captain cancels the team: the team row and the captain's own row both say so.
  expect(await items('Wilcze Stado')).toEqual([
    'Napisz do kapitana', 'Zwróć wpłatę', 'Anuluj drużynę', 'Zmień nazwę drużyny', 'Skład drużyny',
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
  expect(await items('Ola Leśna')).toContain('Anuluj drużynę')

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

// Plan 6 task 6b: the panel's dialogs. O-53 (dialogs), O-54…O-59, O-61 and O-62 in
// docs/registration/scenario-matrix.md (O-60 is Task 7's). Each test seeds its own small event, so a
// refund or a cancel never changes what another test reads.
test.describe('the entries panel dialogs (6b)', () => {
  /** A paid entry the mock holds as paid, so dpay can refund it: the buyer's pay-order, then the payer. */
  async function paidEntry(e, firstName, lastName) {
    const email = runnerEmail(lastName.toLowerCase())
    const out = await orderOk(e, { people: [person(email, { firstName, lastName })] })
    const paid = await callFn('pay-order', await sessionFor(email), { orderId: out.orderId })
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)
    const { data: [attempt] } = await admin().from('payment_attempts').select('dpay_transaction_id')
      .eq('order_id', out.orderId).order('created_at', { ascending: false }).limit(1)
    await payMock(attempt.dpay_transaction_id, 'paid')
    await expect.poll(async () => (await orderOf(out.orderId)).status, { timeout: 15_000 }).toBe('paid')
    return { ...out, email }
  }

  // Bieg 9 km at 60 zł: Jan Kowalski paid, Piotr Zieliński awaiting payment.
  async function small() {
    const e = await createPublishedPaidEvent(owner, { competitions: [{ ...BIEG9, capacity: 10 }], prices: { 'Bieg 9 km': 6000 } })
    const jan = await paidEntry(e, 'Jan', 'Kowalski')
    const piotrEmail = runnerEmail('zielinski')
    const piotr = await orderOk(e, { people: [person(piotrEmail, { firstName: 'Piotr', lastName: 'Zieliński' })] })
    return { ...e, jan, piotr: { ...piotr, email: piotrEmail } }
  }

  // By the name itself: an added adult's row also says „zapisał(a): <buyer>”.
  const row = (page, name) => page.getByTestId('registrations').getByTestId('registration-row')
    .filter({ has: page.getByText(name, { exact: true }) })
  async function choose(page, name, item) {
    const trigger = page.getByRole('button', { name: `Akcje — ${name}` }).first()
    await trigger.click()
    await page.getByRole('menuitem', { name: item, exact: true }).click()
    return trigger
  }

  test.beforeEach(async () => { await dpayReset() })

  test('O-55 „Zwróć wpłatę”: a partial refund, then the rest, which cancels the entry; focus returns to ⋯', async ({ actors }) => {
    const e = await small()
    const page = await open(actors.owner, 1440, zgloszenia(e.eventId))
    const trigger = await choose(page, 'Jan Kowalski', 'Zwróć wpłatę')
    const dialog = page.getByRole('dialog', { name: 'Zwróć wpłatę' })
    await expect(dialog.getByTestId('refund-line')).toHaveCount(1)
    await expect(dialog.getByTestId('refund-line')).toContainText('Opłata startowa · Bieg 9 km · 60,00 zł')
    await expect(dialog.getByTestId('refund-line')).not.toContainText('zwrócono')
    await expect(dialog.getByTestId('refund-line')).toContainText('Maks. 60,00 zł')
    const amount = dialog.getByLabel('Kwota zwrotu — Opłata startowa')
    await expect(amount).toBeFocused()
    await amount.fill('70')
    await expect(dialog).toContainText('Kwota przekracza możliwą do zwrotu: 60,00 zł.')
    await expect(dialog.getByRole('button', { name: /^Zwróć/ })).toBeDisabled()
    await amount.fill('20')
    await dialog.getByRole('button', { name: 'Zwróć 20,00 zł', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('entries-notice')).toHaveText('Zwrócono 20,00 zł — Jan Kowalski.')
    await expect(row(page, 'Jan Kowalski').getByTestId('registration-status')).toHaveText('OPŁACONE · ZWROT 20 ZŁ')
    await expect(trigger).toBeFocused()

    await choose(page, 'Jan Kowalski', 'Zwróć wpłatę')
    await expect(dialog.getByTestId('refund-line')).toContainText('Opłata startowa · Bieg 9 km · 60,00 zł · zwrócono 20,00 zł')
    await expect(dialog).toContainText('Maks. 40,00 zł')
    await dialog.getByLabel('Kwota zwrotu — Opłata startowa').fill('40,00')
    await dialog.getByRole('button', { name: 'Zwróć 40,00 zł i anuluj zgłoszenie' }).click()
    await expect(page.getByTestId('entries-notice')).toHaveText('Zwrócono 40,00 zł — Jan Kowalski.')
    // Before closes_at the participant is removed with the entry, so nothing waits on the host.
    await expect(row(page, 'Jan Kowalski').getByTestId('registration-status')).toHaveText('ANULOWANE')
    expect((await dpayRefunds()).map((r) => r.grosze)).toEqual([2000, 4000])
  })

  test('O-54 after closes_at: no „Edytuj dane” or „Przedłuż termin wpłaty”; a full refund reads „WYCOFAJ W PANELU POMIARU”', async ({ actors }) => {
    const e = await small()
    await setSettings(e.eventId, { closes_at: minutesFromNow(-1) })
    const page = await open(actors.owner, 1440, zgloszenia(e.eventId))
    const items = async (name) => {
      await page.getByRole('button', { name: `Akcje — ${name}` }).click()
      const labels = await page.getByRole('menu').getByRole('menuitem').allTextContents()
      await page.keyboard.press('Escape')
      return labels
    }
    expect(await items('Jan Kowalski')).toEqual(['Napisz do zawodnika', 'Przekaż pakiet', 'Zwróć wpłatę', 'Anuluj zgłoszenie'])
    expect(await items('Piotr Zieliński')).not.toContain('Przedłuż termin wpłaty')
    expect(await items('Piotr Zieliński')).not.toContain('Edytuj dane')

    await choose(page, 'Jan Kowalski', 'Zwróć wpłatę')
    const dialog = page.getByRole('dialog', { name: 'Zwróć wpłatę' })
    await dialog.getByLabel('Kwota zwrotu — Opłata startowa').fill('60')
    await dialog.getByRole('button', { name: 'Zwróć 60,00 zł i anuluj zgłoszenie' }).click()
    await expect(row(page, 'Jan Kowalski').getByTestId('registration-status')).toHaveText('WYCOFAJ W PANELU POMIARU')
    await expect(page.getByTestId('status-chips').getByRole('button', { name: 'Do wycofania w pomiarze · 1' })).toBeVisible()
  })

  test('O-56 a refund dpay does not confirm reads „ZWROT NIEPOTWIERDZONY” and keeps the money reserved', async ({ actors }) => {
    const e = await small()
    const page = await open(actors.owner, 1440, zgloszenia(e.eventId))
    await choose(page, 'Jan Kowalski', 'Zwróć wpłatę')
    const dialog = page.getByRole('dialog', { name: 'Zwróć wpłatę' })
    await dialog.getByLabel('Kwota zwrotu — Opłata startowa').fill('20')
    await dpayMode({ refundFails: true })
    await dialog.getByRole('button', { name: 'Zwróć 20,00 zł' }).click()
    await expect(page.getByTestId('entries-notice')).toHaveText('Zwrot niepotwierdzony — Jan Kowalski.')
    await expect(row(page, 'Jan Kowalski').getByTestId('registration-status')).toHaveText('ZWROT NIEPOTWIERDZONY')
    const [line] = await rows('order_lines', { order_id: e.jan.orderId })
    expect(line.refunded).toBe(2000)
  })

  test('O-56 a refund dpay refused for lack of balance can be retried in the same dialog once the balance is there', async ({ actors }) => {
    const e = await small()
    const page = await open(actors.owner, 1440, zgloszenia(e.eventId))
    await choose(page, 'Jan Kowalski', 'Zwróć wpłatę')
    const dialog = page.getByRole('dialog', { name: 'Zwróć wpłatę' })
    await dialog.getByLabel('Kwota zwrotu — Opłata startowa').fill('20')
    await dpayMode({ refundInsufficient: true })
    await dialog.getByRole('button', { name: 'Zwróć 20,00 zł' }).click()
    await expect(dialog.getByTestId('dialog-error')).toHaveText('Operator płatności odrzucił zwrot: brak środków.')
    await dpayMode({ refundInsufficient: false })
    await dialog.getByRole('button', { name: 'Zwróć 20,00 zł' }).click()
    await expect(page.getByTestId('entries-notice')).toHaveText('Zwrócono 20,00 zł — Jan Kowalski.')
    expect((await dpayRefunds()).map((r) => r.grosze)).toEqual([2000])
  })

  test('O-57 „Przedłuż termin wpłaty” moves the deadline, never past closes_at; Escape closes and returns focus; both payment items stop an hour before close', async ({ actors }) => {
    const e = await small()
    const closes = minutesFromNow(10 * 24 * 60)
    await setSettings(e.eventId, { closes_at: closes })
    const page = await open(actors.owner, 1440, zgloszenia(e.eventId))
    const trigger = await choose(page, 'Piotr Zieliński', 'Przedłuż termin wpłaty')
    const dialog = page.getByRole('dialog', { name: 'Przedłuż termin wpłaty' })
    await expect(dialog).toContainText('Przedłużenie nie rezerwuje miejsca.')
    await expect(dialog.getByRole('radio')).toHaveCount(3)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()

    await choose(page, 'Piotr Zieliński', 'Przedłuż termin wpłaty')
    // + 7 dni from the 7-day deadline is capped at closes_at, 10 days away; „+ 14 dni” and „Do końca
    // zapisów” would land on the same instant, so they are disabled.
    await expect(dialog.getByRole('radio', { name: /\+ 14 dni/ })).toBeDisabled()
    await expect(dialog.getByRole('radio', { name: /Do końca zapisów/ })).toBeDisabled()
    await dialog.getByRole('radio', { name: /\+ 7 dni/ }).check()
    await dialog.getByRole('button', { name: 'Przedłuż' }).click()
    await expect(page.getByTestId('entries-notice')).toContainText('Nowy termin wpłaty: ')
    expect(Date.parse((await orderOf(e.piotr.orderId)).expires_at)).toBe(Date.parse(closes))

    // There is room in Bieg 9 km, so the reminder is offered and goes out.
    await choose(page, 'Piotr Zieliński', 'Przypomnij o wpłacie')
    await expect(page.getByTestId('entries-notice')).toHaveText('Przypomnienie wysłane — Piotr Zieliński.')

    // From an hour before closes_at online payment stops (paying_closed): neither item is offered.
    await setSettings(e.eventId, { closes_at: minutesFromNow(30) })
    await page.reload()
    await page.getByRole('button', { name: 'Akcje — Piotr Zieliński' }).click()
    const labels = await page.getByRole('menu').getByRole('menuitem').allTextContents()
    expect(labels).toEqual(['Edytuj dane', 'Napisz do zawodnika', 'Anuluj nieopłacone zgłoszenie'])
  })

  test('O-57 two choices a day apart; Shift+Tab from the checked one stays in the dialog', async ({ actors }) => {
    const e = await small()
    await setSettings(e.eventId, { closes_at: minutesFromNow(20 * 24 * 60) })
    await admin().from('orders').update({ expires_at: minutesFromNow(24 * 60) }).eq('id', e.piotr.orderId)
    const page = await open(actors.owner, 1440, zgloszenia(e.eventId))
    await choose(page, 'Piotr Zieliński', 'Przedłuż termin wpłaty')
    const dialog = page.getByRole('dialog', { name: 'Przedłuż termin wpłaty' })
    await expect(dialog.getByRole('radio', { name: /\+ 7 dni/ })).toBeEnabled()
    await expect(dialog.getByRole('radio', { name: /Do końca zapisów/ })).toBeDisabled()
    await dialog.getByRole('radio', { name: /\+ 14 dni/ }).check()
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab')
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
    }
  })

  test('O-58 „Anuluj nieopłacone zgłoszenie” cancels the unpaid order', async ({ actors }) => {
    const e = await small()
    const page = await open(actors.owner, 1440, zgloszenia(e.eventId))
    // A paid entry is cancelled without a refund, and its dialog says how much stays.
    await choose(page, 'Jan Kowalski', 'Anuluj zgłoszenie')
    const paid = page.getByRole('dialog', { name: 'Anulować zgłoszenie?' })
    await expect(paid.getByTestId('cancel-no-refund')).toHaveText('BEZ ZWROTU · 60,00 zł')
    await paid.getByRole('button', { name: 'Nie', exact: true }).click()
    await expect(paid).toHaveCount(0)
    await choose(page, 'Piotr Zieliński', 'Anuluj nieopłacone zgłoszenie')
    const dialog = page.getByRole('dialog', { name: 'Anulować nieopłacone zgłoszenie?' })
    await expect(dialog.getByTestId('cancel-people')).toHaveCount(0)
    await expect(dialog).toContainText('Piotr Zieliński · Bieg 9 km')
    await dialog.getByRole('button', { name: 'Anuluj nieopłacone zgłoszenie' }).click()
    await expect(row(page, 'Piotr Zieliński').getByTestId('registration-status')).toHaveText('ANULOWANE')
    const order = await orderOf(e.piotr.orderId)
    expect([order.status, order.cancelled_reason]).toEqual(['cancelled', 'organizer_cancelled'])
  })

  test('O-58 cancelling one entry of an unpaid group order names everyone the order cancels (ruling 6)', async ({ actors }) => {
    const e = await small()
    const group = await orderOk(e, { people: [
      person(runnerEmail('marta'), { firstName: 'Marta', lastName: 'Nowak' }),
      person(runnerEmail('kuba'), { firstName: 'Kuba', lastName: 'Nowak' }),
      person(runnerEmail('ala'), { firstName: 'Ala', lastName: 'Nowak' }),
    ] })
    const page = await open(actors.owner, 1440, zgloszenia(e.eventId))
    await choose(page, 'Kuba Nowak', 'Anuluj nieopłacone zgłoszenie')
    const dialog = page.getByRole('dialog', { name: 'Anulować nieopłacone zamówienie (3 os.)?' })
    // One order's rows share their sign-up instant, so their order is the ids'.
    const listed = await dialog.getByTestId('cancel-people').getByRole('listitem').allTextContents()
    expect(listed.sort()).toEqual(['Ala Nowak · Bieg 9 km', 'Kuba Nowak · Bieg 9 km', 'Marta Nowak · Bieg 9 km'])
    await dialog.getByRole('button', { name: 'Anuluj zamówienie (3 os.)' }).click()
    await expect(dialog).toHaveCount(0)
    for (const name of ['Marta Nowak', 'Kuba Nowak', 'Ala Nowak']) {
      await expect(row(page, name).getByTestId('registration-status')).toHaveText('ANULOWANE')
    }
    await expect(row(page, 'Piotr Zieliński').getByTestId('registration-status')).toContainText('CZEKA NA WPŁATĘ')
    expect((await orderOf(group.orderId)).status).toBe('cancelled')
  })

  test('O-59 „Edytuj dane” saves the changed fields and shows a refusal under its field', async ({ actors }) => {
    const e = await small()
    const page = await open(actors.owner, 1440, zgloszenia(e.eventId))
    await choose(page, 'Jan Kowalski', 'Edytuj dane')
    const dialog = page.getByRole('dialog', { name: 'Edytuj dane' })
    await expect(dialog.getByLabel('Imię', { exact: true })).toHaveValue('Jan')
    await dialog.getByLabel('Miejscowość').fill('Gdańsk')
    await dialog.getByLabel('Telefon', { exact: true }).fill('')
    await dialog.getByRole('button', { name: 'Zapisz' }).click()
    await expect(dialog.getByLabel('Telefon', { exact: true })).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog).toContainText('Podaj numer telefonu.')
    await dialog.getByLabel('Telefon', { exact: true }).fill('+48 600 700 800')
    await dialog.getByRole('button', { name: 'Zapisz' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('entries-notice')).toHaveText('Zapisano — Jan Kowalski.')
    const [reg] = await rows('registrations', { order_id: e.jan.orderId })
    expect([reg.city, reg.phone]).toEqual(['Gdańsk', '+48 600 700 800'])

    // A field the event switched off is not offered; nationality is offered once it is on.
    await setSettings(e.eventId, { form_fields: { city: 'optional', club: 'off', ice: 'off', nationality: 'optional' } })
    await page.reload()
    await choose(page, 'Jan Kowalski', 'Edytuj dane')
    await expect(dialog.getByLabel('Miejscowość')).toHaveValue('Gdańsk')
    await expect(dialog.getByLabel('Klub')).toHaveCount(0)
    await expect(dialog.getByLabel('Kontakt w razie wypadku — imię')).toHaveCount(0)
    await expect(dialog.getByLabel('Narodowość')).toHaveValue('')
  })

  test('O-61 „Wiadomość do uczestników”: the count follows the audience, a test goes to me, then the message', async ({ actors }) => {
    const e = await small()
    const page = await open(actors.owner, 1440, zgloszenia(e.eventId))
    await page.getByRole('button', { name: 'Wiadomość do uczestników' }).click()
    const dialog = page.getByRole('dialog', { name: 'Wiadomość do uczestników' })
    await expect(dialog).toContainText('Od: Zatyrani Test przez LESZY.RUN')
    await expect(dialog).toContainText('Odpowiedzi na: zapisy@klub.example')
    await expect(dialog.getByTestId('message-count')).toHaveText('DO 1 OSOBY')
    await dialog.getByRole('button', { name: 'Wszyscy zgłoszeni' }).click()
    await expect(dialog.getByTestId('message-count')).toHaveText('DO 2 OSÓB')

    await dialog.getByRole('button', { name: 'Wyślij', exact: true }).click()
    await expect(dialog.getByLabel('Temat')).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog).toContainText('Podaj temat wiadomości.')
    const subject = `Odbiór pakietów ${Date.now()}`
    await dialog.getByLabel('Temat').fill(subject)
    await dialog.getByLabel('Treść').fill('Biuro zawodów od 8:00.')
    await dialog.getByRole('button', { name: 'Wyślij test do mnie' }).click()
    await expect(dialog.getByRole('status')).toHaveText('Test wysłany.')
    expect((await messagesTo(ACTOR_EMAILS.owner)).filter((m) => m.subject === subject)).toHaveLength(1)

    await dialog.getByRole('button', { name: 'Wyślij', exact: true }).click()
    await expect(page.getByTestId('entries-notice')).toHaveText('Wysłano do 2 osób.')
    for (const email of [e.jan.email, e.piotr.email]) {
      const got = (await messagesTo(email)).filter((m) => m.subject === subject)
      expect(got.map((m) => [m.fromName, m.replyTo])).toEqual([['Zatyrani Test przez LESZY.RUN', 'zapisy@klub.example']])
    }
  })

  test('O-61 a test the sender refuses answers 502 in the dialog; a failed count does not leave „Wyślij” stuck', async ({ browser }) => {
    const e = await small()
    // The owner, signed in under an address the e-mail sender refuses (capture: runner-bounce-…).
    const { data: profile } = await admin().from('profiles').select('id').eq('email', ACTOR_EMAILS.owner).single()
    const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
    const { error } = await admin().from('auth_sessions').insert({
      id: token, user_id: profile.id, email: runnerEmail('bounce'), expires_at: minutesFromNow(60),
    })
    expect(error).toBeNull()
    const context = await browser.newContext()
    await context.addCookies([{ name: 'leszy_session', value: token, domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }])
    try {
      const page = await open(context, 1440, zgloszenia(e.eventId))
      // The count fails on the way while `failing`; the next audience change asks again and clears it.
      let failing = true
      await page.route('**/send-organizer-message', (route) => (failing ? route.abort() : route.continue()))
      await page.getByRole('button', { name: 'Wiadomość do uczestników' }).click()
      const dialog = page.getByRole('dialog', { name: 'Wiadomość do uczestników' })
      await expect(dialog.getByTestId('dialog-error')).toHaveText('Brak połączenia.')
      await expect(dialog.getByRole('button', { name: 'Wyślij', exact: true })).toBeDisabled()
      failing = false
      await dialog.getByRole('button', { name: 'Wszyscy zgłoszeni' }).click()
      await expect(dialog.getByTestId('message-count')).toHaveText('DO 2 OSÓB')
      await expect(dialog.getByTestId('dialog-error')).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: 'Wyślij', exact: true })).toBeEnabled()

      await dialog.getByLabel('Temat').fill('Próba')
      await dialog.getByLabel('Treść').fill('Treść próby.')
      await dialog.getByRole('button', { name: 'Wyślij test do mnie' }).click()
      await expect(dialog.getByTestId('dialog-error')).toHaveText('Nie udało się wysłać wiadomości próbnej. Spróbuj ponownie za chwilę.')
      await expect(dialog.getByRole('status')).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: 'Wyślij test do mnie' })).toBeEnabled()
    } finally {
      await context.close()
    }
  })

  test('O-63 a captain\'s team: „Anulować drużynę?” names the team, and a full refund reads „… i anuluj drużynę (2 os.)”', async ({ actors }) => {
    const e = await createPublishedPaidEvent(owner, { competitions: [STAFETA], prices: { Sztafeta: 24000 } })
    const { data: consents } = await admin().from('event_consents').select('id').eq('event_id', e.eventId)
    const r = await callFn('register-team', captain, {
      categoryId: e.categoryIds[0], teamName: 'Szybkie Sowy',
      members: [
        { person: member({ firstName: 'Ola', lastName: 'Leśna', birthDate: '1988-03-01', gender: 'K', email: ACTOR_EMAILS.runner }) },
        { person: member({ firstName: 'Piotr', email: runnerEmail('piotr') }) },
      ],
      membersConsent: true, acceptedConsentIds: consents.map((c) => c.id), serviceRegulamin: true, displayedTotal: 24000,
    })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const paid = await callFn('pay-order', captain, { orderId: r.body.data.orderId })
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)
    const { data: [attempt] } = await admin().from('payment_attempts').select('dpay_transaction_id')
      .eq('order_id', r.body.data.orderId).order('created_at', { ascending: false }).limit(1)
    await payMock(attempt.dpay_transaction_id, 'paid')
    await expect.poll(async () => (await orderOf(r.body.data.orderId)).status, { timeout: 15_000 }).toBe('paid')

    const page = await open(actors.owner, 1440, zgloszenia(e.eventId))
    await choose(page, 'Szybkie Sowy', 'Anuluj drużynę')
    const cancel = page.getByRole('dialog', { name: 'Anulować drużynę?' })
    await expect(cancel).toContainText('Szybkie Sowy · 2 os.')
    await expect(cancel.getByTestId('cancel-no-refund')).toHaveText('BEZ ZWROTU · 240,00 zł')
    await cancel.getByRole('button', { name: 'Nie', exact: true }).click()

    await choose(page, 'Szybkie Sowy', 'Zwróć wpłatę')
    const refund = page.getByRole('dialog', { name: 'Zwróć wpłatę' })
    await expect(refund).toContainText('Szybkie Sowy · 2 os.')
    await refund.getByLabel('Kwota zwrotu — Opłata startowa').fill('240')
    await refund.getByRole('button', { name: 'Zwróć 240,00 zł i anuluj drużynę (2 os.)' }).click()
    await expect(page.getByTestId('entries-notice')).toHaveText('Zwrócono 240,00 zł — Ola Leśna.')
    // The team is released with its captain: both people are cancelled rows now.
    await expect(page.getByTestId('registrations').getByTestId('team-row')).toHaveCount(0)
    await expect(row(page, 'Piotr Leśny').getByTestId('registration-status')).toHaveText('ANULOWANE')
  })

  test('O-61 „Napisz do zawodnika” writes to that one entry', async ({ actors }) => {
    const e = await small()
    const page = await open(actors.owner, 1440, zgloszenia(e.eventId))
    await choose(page, 'Piotr Zieliński', 'Napisz do zawodnika')
    const dialog = page.getByRole('dialog', { name: 'Napisz do zawodnika' })
    await expect(dialog.getByRole('group', { name: 'Status' })).toHaveCount(0)
    await expect(dialog.getByTestId('message-count')).toHaveText('DO 1 OSOBY')
    await dialog.getByLabel('Temat').fill('Wpłata')
    await dialog.getByLabel('Treść').fill('Czekamy na wpłatę.')
    await dialog.getByRole('button', { name: 'Wyślij', exact: true }).click()
    await expect(page.getByTestId('entries-notice')).toHaveText('Wysłano do 1 osoby.')
    expect((await messagesTo(e.piotr.email)).filter((m) => m.subject === 'Wpłata')).toHaveLength(1)
    expect((await messagesTo(e.jan.email)).filter((m) => m.subject === 'Wpłata')).toHaveLength(0)
  })

  test('O-53 the dialogs at 390 px: no button wraps, nothing scrolls sideways, Tab stays inside', async ({ actors }) => {
    const e = await small()
    const page = await open(actors.owner, 390, zgloszenia(e.eventId))
    const wrapped = () => page.locator('[role="dialog"] button:visible').evaluateAll((els) => els.filter((el) => {
      const s = getComputedStyle(el)
      const line = Number.parseFloat(s.lineHeight) || Number.parseFloat(s.fontSize) * 1.5
      const chrome = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((n, k) => n + Number.parseFloat(s[k]), 0)
      const single = Math.max(Number.parseFloat(s.minHeight) || 0, line + chrome)
      return el.getBoundingClientRect().height > single + 1 || el.scrollWidth > el.clientWidth + 1
    }).map((el) => el.textContent))
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    const cards = page.getByTestId('registrations-cards')
    const openFromCard = async (name, item) => {
      await cards.getByRole('button', { name: `Akcje — ${name}` }).click()
      await page.getByRole('menuitem', { name: item, exact: true }).click()
    }
    for (const [name, item] of [
      ['Jan Kowalski', 'Zwróć wpłatę'], ['Piotr Zieliński', 'Przedłuż termin wpłaty'], ['Piotr Zieliński', 'Anuluj nieopłacone zgłoszenie'],
      ['Jan Kowalski', 'Edytuj dane'], ['Jan Kowalski', 'Napisz do zawodnika'],
    ]) {
      await openFromCard(name, item)
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      if (item === 'Zwróć wpłatę') await dialog.getByLabel('Kwota zwrotu — Opłata startowa').fill('60')
      expect(await wrapped(), item).toEqual([])
      expect(await sideways(), item).toBe(true)
      // Tab from the last control comes back to the first, never to the page behind.
      for (let i = 0; i < 40; i++) await page.keyboard.press('Tab')
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), item).toBe(true)
      for (let i = 0; i < 40; i++) await page.keyboard.press('Shift+Tab')
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), `${item} (Shift+Tab)`).toBe(true)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    }
    await page.getByRole('button', { name: 'Wiadomość do uczestników' }).click()
    await expect(page.getByRole('dialog').getByTestId('message-count')).toHaveText('DO 1 OSOBY')
    expect(await wrapped()).toEqual([])
    expect(await sideways()).toBe(true)
  })

  test('O-62 „Zmień nazwę drużyny” renames the team and shows the server\'s refusal under the field', async ({ actors }) => {
    const e = await createPublishedPaidEvent(owner, { competitions: [STAFETA], prices: { Sztafeta: 24000 } })
    const { data: consents } = await admin().from('event_consents').select('id').eq('event_id', e.eventId)
    const r = await callFn('register-team', captain, {
      categoryId: e.categoryIds[0], teamName: 'Wilcze Stado',
      members: [
        { person: member({ firstName: 'Ola', lastName: 'Leśna', birthDate: '1988-03-01', gender: 'K', email: ACTOR_EMAILS.runner }) },
        { person: member({ firstName: 'Piotr', email: runnerEmail('piotr') }) },
      ],
      membersConsent: true, acceptedConsentIds: consents.map((c) => c.id), serviceRegulamin: true, displayedTotal: 24000,
    })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const page = await open(actors.owner, 1440, zgloszenia(e.eventId))
    const trigger = await choose(page, 'Wilcze Stado', 'Zmień nazwę drużyny')
    const dialog = page.getByRole('dialog', { name: 'Zmień nazwę drużyny' })
    const name = dialog.getByLabel('Nazwa drużyny')
    await expect(name).toHaveValue('Wilcze Stado')
    await name.fill('W')
    await dialog.getByRole('button', { name: 'Zapisz' }).click()
    await expect(name).toHaveAttribute('aria-invalid', 'true')
    await name.fill('Leśne Wilki')
    await dialog.getByRole('button', { name: 'Zapisz' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('registrations').getByTestId('team-row')).toContainText('Leśne Wilki · 2 os.')
    await expect(page.getByTestId('entries-notice')).toHaveText('Nowa nazwa drużyny: Leśne Wilki.')
    await expect(page.getByRole('button', { name: 'Akcje — Leśne Wilki' })).toBeFocused()
    expect(trigger).toBeTruthy()
  })
})
