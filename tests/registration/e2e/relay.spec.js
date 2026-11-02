import crypto from 'node:crypto'
import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, makeEventPaid } from '../helpers/registrationFixtures.js'
import { dpayReset, dpayTransactions } from '../helpers/dpayControl.js'
import { DPAY_MOCK_PORT } from '../helpers/dpayMock.js'
import { captureRequests, clearMessages, lastCodeFor, messagesTo } from '../helpers/emailCapture.js'
import { startScratchHost } from '../helpers/hostPull.js'
import { VITE_BASE_PORT, slotPort } from '../helpers/slot.js'

// Plan 5 task 9: a relay across every audience at once (T-80 in
// docs/registration/scenario-matrix.md). `owner` builds a paid „Sztafeta rodzinna” in the wizard,
// `runner` registers „Wilcze Szczenięta” (self, an added adult, 17 y, 16 y) and pays on the mock,
// `viewer` reads the public start list, `invitee` accepts from the link in their e-mail, `runner`
// then swaps a child and reorders, and the timing host pulls the result.
// The wizard publishes a free event and the price comes from makeEventPaid, the step
// createPublishedPaidEvent uses (a shortcut: P-43 publishes a paid draft through the wizard).

const ZT = '00000000-0000-4000-8000-0000000000c1'
const TEAM = 'Wilcze Szczenięta'
const RELAY = 'Sztafeta rodzinna'
const FEE = 24000
const TOKEN_RE = /\/zgoda#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/
const PAY_PAGE = new RegExp(`localhost:${DPAY_MOCK_PORT}\\/pay\\/`)
const SITE = 'http://localhost:5173' // PUBLIC_SITE_URL in functions.env
const VITE = `http://localhost:${slotPort(VITE_BASE_PORT)}`
const DAY_MS = 24 * 3600 * 1000
const rand = () => crypto.randomBytes(4).toString('hex')
const isoDay = (offset) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10)

/** A birth date that makes `years` on the race day (30 days from now), whatever today is. */
const birthFor = (years) => {
  const raceDay = new Date(Date.now() + 30 * DAY_MS)
  return new Date(Date.UTC(raceDay.getUTCFullYear() - years, raceDay.getUTCMonth(), raceDay.getUTCDate() - 7)).toISOString().slice(0, 10)
}

test.beforeAll(async () => {
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const status = await callFn('organizer-status', owner, { clubId: ZT })
  if (!status.body.data.agreementAccepted) {
    await callFn('accept-organizer-agreement', owner, { clubId: ZT, version: status.body.data.version })
  }
  await dpayReset()
})
test.beforeEach(async () => { await resetThrottle() })

async function open(context) {
  const page = await context.newPage()
  await page.route(/tile\.openstreetmap\.org|unpkg\.com/, (route) => route.fulfill({ status: 204, body: '' }))
  // The mock sends the payer back to PUBLIC_SITE_URL, and this suite's Vite is elsewhere: as paid-registration.spec.js.
  await page.route(new RegExp(`localhost:${DPAY_MOCK_PORT}\\/pay\\/[^/]+\\/(paid|declined)$`), async (route) => {
    const res = await route.fetch({ maxRedirects: 0 })
    const to = (res.headers().location ?? '').replace(SITE, VITE)
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(to)})</script>` })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  return page
}

async function fillCard(page, prefix, { first, last, birth, gender, email, phone = '600300400' }) {
  await page.locator(`#${prefix}-first`).fill(first)
  await page.locator(`#${prefix}-last`).fill(last)
  await page.locator(`#${prefix}-birth`).fill(birth)
  await page.locator(`[aria-labelledby="${prefix}-gender-label"]`).getByRole('button', { name: gender, exact: true }).click()
  if (email !== undefined) await page.locator(`#${prefix}-email`).fill(email)
  if (phone !== undefined && await page.locator(`#${prefix}-phone`).count()) await page.locator(`#${prefix}-phone`).fill(phone)
}

async function tickAll(page) {
  const boxes = page.getByTestId('consents').getByRole('checkbox')
  await expect(boxes.first()).toBeVisible()
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
}

async function mailsTo(address, n) {
  for (let i = 0; i < 60; i++) {
    const msgs = await messagesTo(address)
    if (msgs.length >= n) return msgs
    await new Promise((r) => setTimeout(r, 250))
  }
  return messagesTo(address)
}

/** Basics through the edge function (W-25 walks them by hand), the relay and publishing in the wizard. */
async function ownerBuildsTheEvent(page, owner) {
  const name = `Sztafeta Leszego ${rand()}`
  const created = await callFn('create-registration-event', owner, { clubId: ZT, name })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  const { eventId } = created.body.data
  const basics = await callFn('save-registration-section', owner, { eventId, section: 'basics', value: {
    eventDate: isoDay(30), opensOn: isoDay(-1), closesOn: isoDay(30), firstStartTime: '10:00',
    townLabel: 'Nieborowice', townArea: 'GM. PILCHOWICE · ŚLĄSKIE', lat: 50.2381, lng: 18.5412,
    regulaminKind: 'link', regulaminUrl: 'https://example.org/regulamin.pdf', contactEmail: 'zapisy@klub.example',
  } })
  expect(basics.status, JSON.stringify(basics.body)).toBe(200)
  // The runner fields as they were before city and club became required by default
  // (migration 20261105090000), like createPublishedFreeEvent: this suite's people give neither.
  const form = await callFn('save-registration-section', owner, { eventId, section: 'form', value: {
    formFields: { city: 'optional', club: 'optional', ice: 'optional', nationality: 'off' },
  } })
  expect(form.status, JSON.stringify(form.body)).toBe(200)

  const steps = `/klub/zatyrani-test/wydarzenia/${eventId}`
  await page.goto(`${steps}/konkurencje`)
  await page.getByRole('button', { name: '+ Konkurencja' }).click()
  await page.getByLabel('Nazwa konkurencji 1').fill(RELAY)
  await page.getByLabel('Dystans 1').fill('4 x 2 km')
  await page.getByLabel('Start 1').fill('10:00')
  await page.getByLabel('Rodzaj 1').selectOption('team')
  await page.getByLabel('Skład od 1').fill('3')
  await page.getByLabel('Skład do 1').fill('5')
  await page.getByLabel('Limit 1').fill('20')
  await page.getByRole('radio', { name: 'Bezpłatne' }).check()
  const competitions = async () => {
    const { data, error } = await admin().from('competitions').select('*').eq('event_id', eventId)
    if (error) throw error
    return data
  }
  await expect.poll(async () => (await competitions()).map((c) => [c.name, c.kind, c.team_min, c.team_max, c.capacity]), { timeout: 15_000 })
    .toEqual([[RELAY, 'team', 3, 5, 20]])

  await page.goto(`${steps}/formularz`)
  await page.getByRole('group', { name: `Kolejność zmian: ${RELAY}` }).getByRole('button', { name: 'Zbieraj' }).click()
  await expect.poll(async () => (await competitions())[0].leg_order_enabled, { timeout: 15_000 }).toBe(true)

  await page.getByRole('button', { name: 'Dalej: dodatki' }).click()
  await page.getByRole('button', { name: 'Dalej: partnerzy' }).click()
  await page.getByRole('button', { name: 'Dalej: publikacja' }).click()
  await expect(page.getByTestId('checklist')).toBeVisible()
  await expect(page.getByTestId('blocking-item')).toHaveCount(0)
  await page.getByRole('button', { name: /^Opublikuj/ }).click()
  await expect(page.getByTestId('published')).toContainText('OPUBLIKOWANE')

  const [{ category_id: categoryId }] = await competitions()
  const { data: settings, error } = await admin().from('registration_settings').select('slug').eq('event_id', eventId).single()
  if (error) throw error
  return { name, ...(await makeEventPaid({ eventId, categoryIds: [categoryId], slug: settings.slug }, { prices: { [RELAY]: FEE } })) }
}

/** RA1 → RB1 → RB2 → RB3 → the mock's page → paid. → the team's row. */
async function runnerRegistersAndPays(page, event, inviteeEmail) {
  await page.goto(`/events/${event.slug}`)
  await page.getByTestId('competition').first().click()
  await page.getByLabel('Nazwa drużyny').fill(TEAM)
  await page.getByTestId('team-size').getByRole('button', { name: '4', exact: true }).click()
  await fillCard(page, 'p', { first: 'Ola', last: 'Leśna', birth: '1988-03-01', gender: 'Kobieta', email: ACTOR_EMAILS.runner, phone: '600100200' })
  await tickAll(page)
  await page.getByRole('button', { name: 'Dalej: skład' }).click()

  await fillCard(page, 'p2', { first: 'Piotr', last: 'Borowy', birth: '1987-01-01', gender: 'Mężczyzna', email: inviteeEmail })
  await page.getByTestId('person-done').click()
  for (const [prefix, child] of [
    ['p3', { first: 'Zosia', last: 'Leśna', birth: birthFor(17), gender: 'Dziewczynka' }],
    ['p4', { first: 'Staś', last: 'Leśny', birth: birthFor(16), gender: 'Chłopiec' }],
  ]) {
    await fillCard(page, prefix, { ...child, phone: undefined })
    await page.getByTestId('person-done').click()
    await page.getByTestId('guardian-consent').check()
    await page.getByTestId('person-done').click()
  }
  await page.getByTestId('members-consent').check()
  await page.getByRole('button', { name: 'Dalej: płatność' }).click()

  await expect(page.getByTestId('checkout-line-price')).toHaveText('240,00 zł')
  await page.getByTestId('pay').click()
  await expect(page).toHaveURL(PAY_PAGE)
  await page.getByRole('button', { name: 'Zapłać (mock)' }).click()
  await expect(page.getByTestId('order-paid')).toBeVisible({ timeout: 30_000 })

  const { data: team, error } = await admin().from('teams').select('*').eq('event_id', event.eventId).single()
  if (error) throw error
  return team
}

async function inviteeAccepts(context, email, token) {
  const page = await open(context)
  await page.goto(`/zgoda#${token}`)
  await page.getByRole('button', { name: 'Wyślij kod' }).click()
  let code = null
  for (let i = 0; i < 40 && !code; i++) {
    if ((await messagesTo(email)).length >= 2) code = await lastCodeFor(email)
    if (!code) await page.waitForTimeout(250)
  }
  expect(code).toMatch(/^\d{6}$/)
  await page.locator('#consent-code').fill(code)
  await page.getByRole('button', { name: 'Dalej' }).click()
  await tickAll(page)
  await page.getByRole('button', { name: 'Akceptuję regulamin' }).click()
  await expect(page.getByTestId('consent-done')).toContainText('Dziękujemy — regulamin zaakceptowany.')
}

test('T-80 a relay across every audience: built in the wizard, paid once, one consent e-mail, the list and ZGODY follow the acceptance, a swap and a reorder, and the host gets people, never a team name', async ({ actors }) => {
  test.slow()
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const inviteeEmail = `piotr-${rand()}@test.local`
  const org = await open(actors.owner)
  const event = await ownerBuildsTheEvent(org, owner)
  await clearMessages()

  const runner = await open(actors.runner)
  const team = await runnerRegistersAndPays(runner, event, inviteeEmail)
  expect(team.name).toBe(TEAM)
  expect((await dpayTransactions()).at(-1).grosze).toBe(FEE)

  // One e-mail to the captain, with the squad link; one consent request; nobody else.
  const captainMails = await mailsTo(ACTOR_EMAILS.runner, 1)
  expect(captainMails.map((m) => m.subject)).toEqual([`Drużyna ${TEAM} jest na liście — ${event.name}`])
  expect(captainMails[0].text).toContain(`/events/${event.slug}/druzyna/${team.id}`)
  const consentMails = await mailsTo(inviteeEmail, 1)
  expect(consentMails).toHaveLength(1)
  expect(consentMails[0].subject).toMatch(/^Zapisano Cię na .+ — zaakceptuj regulamin$/)
  expect((await captureRequests()).map((r) => [r.to].flat().join())).toHaveLength(2)

  // viewer: the team and three full names (#373). Piotr has not accepted, so he is counted, not named (T-74).
  const viewer = await open(actors.viewer)
  await viewer.goto(`/events/${event.slug}/lista`)
  const entry = viewer.getByTestId('start-list-entry')
  await expect(entry).toHaveCount(1)
  await expect(entry).toContainText(TEAM)
  for (const name of ['Ola Leśna', 'Zosia Leśna', 'Staś Leśny']) await expect(entry).toContainText(name)
  await expect(entry).not.toContainText('Piotr')
  await expect(entry).not.toContainText('Borowy')
  await expect(entry).toContainText('+1 czeka na potwierdzenie')
  await expect(entry.locator('td').nth(4)).toHaveText('4')
  await expect(viewer.getByTestId('list-competition')).toContainText(`${RELAY} · drużyny`)
  await expect(viewer.getByTestId('list-competition')).toContainText('1 / 20')

  // owner: three of four.
  const zgloszenia = `/klub/zatyrani-test/wydarzenia/${event.eventId}/zgloszenia`
  await org.goto(zgloszenia)
  const row = org.getByTestId('registrations').getByTestId('team-row')
  await expect(row).toContainText('ZGODY 3/4')
  await expect(row).toContainText('OPŁACONA')

  // invitee: the link from the e-mail. The owner and the viewer then see all four.
  const token = consentMails[0].text.match(TOKEN_RE)?.[1]
  expect(token).toBeTruthy()
  await inviteeAccepts(actors.invitee, inviteeEmail, token)
  await org.reload()
  await expect(row).toContainText('ZGODY 4/4')
  await viewer.reload()
  for (const first of ['Ola', 'Piotr', 'Zosia', 'Staś']) await expect(entry).toContainText(first)

  // The operator hands out bibs, then the host follows the swap.
  const host = await startScratchHost()
  try {
    await host.pull()
    const pulled = await host.sql`select id, first_name from participants where category_id = ${event.categoryIds[0]}`
    expect(pulled.map((p) => p.first_name).sort()).toEqual(['Ola', 'Piotr', 'Staś', 'Zosia'])
    pulled.sort((a, b) => a.first_name.localeCompare(b.first_name))
    // What the bib office and the host's push worker do together. A row left dirty here would never
    // be pulled again, and a bib not pushed would be overwritten by the next pull.
    for (const [i, p] of pulled.entries()) {
      await host.sql`update participants set bib_number = ${i + 1}, synced_at = now() where id = ${p.id}`
      const { error: pushed } = await admin().from('participants').update({ bib_number: i + 1 }).eq('id', p.id)
      if (pushed) throw pushed
    }

    // runner: the squad link from the e-mail, swap the 16-year-old, then the order.
    await runner.goto(captainMails[0].text.match(/https?:\/\/[^\s"]+\/druzyna\/[0-9a-f-]+/)[0].replace(/^https?:\/\/[^/]+/, ''))
    const members = runner.getByTestId('team-member')
    await expect(members).toHaveCount(4)
    await runner.getByRole('button', { name: 'Wymień zawodnika' }).click()
    await runner.getByRole('button', { name: 'Wymień — Staś Leśny' }).click()
    await runner.locator('#m-first').fill('Kuba')
    await runner.locator('#m-last').fill('Leśny')
    await runner.locator('#m-birth').fill(birthFor(15))
    await runner.locator('[aria-labelledby="m-gender-label"]').getByRole('button', { name: 'Chłopiec', exact: true }).click()
    await runner.locator('#m-phone').fill('600900100')
    await tickAll(runner)
    await runner.getByTestId('guardian-consent').check()
    await runner.getByRole('button', { name: 'Wymień zawodnika' }).click()
    await runner.getByTestId('remove-yes').click()
    await expect(members.filter({ hasText: 'Kuba Leśny' })).toHaveCount(1)
    await expect(runner.getByText('Staś Leśny')).toHaveCount(0)

    await runner.getByRole('button', { name: 'Zmień kolejność zmian' }).click()
    await runner.getByRole('button', { name: 'Wyżej — Kuba Leśny' }).click()
    await runner.getByRole('button', { name: 'Zapisz kolejność' }).click()
    await expect(members.filter({ hasText: 'Kuba Leśny' })).toContainText('ZMIANA 3')
    const { data: legs, error } = await admin().from('registrations').select('first_name, team_leg')
      .eq('team_id', team.id).eq('status', 'confirmed').order('team_leg')
    if (error) throw error
    expect(legs.map((l) => l.first_name)).toEqual(['Ola', 'Piotr', 'Kuba', 'Zosia'])

    await host.pull()
    const after = (await host.sql`select first_name, bib_number, removed_at from participants where category_id = ${event.categoryIds[0]} order by first_name`)
      .map((p) => ({ first: p.first_name, bib: p.bib_number, removed: p.removed_at !== null }))
    expect(after).toHaveLength(5)
    // Final review I-3: the swapped-out participant keeps its bib and EPC, never its name.
    expect(after.filter((p) => p.removed).map((p) => p.first)).toEqual(['Usunięte zgłoszenie'])
    expect(after.find((p) => p.removed).bib).toBe(3)
    expect(after.some((p) => p.first === 'Staś')).toBe(false)
    expect(after.find((p) => p.first === 'Kuba').bib).toBeNull()

    // A timing host never learns a team's name: no table, no column, no value.
    const named = await host.sql`select table_name from information_schema.tables where table_schema = 'public' and table_name = 'teams'`
    expect(named).toHaveLength(0)
    const dump = await host.sql`select to_jsonb(p)::text as row from participants p where event_id = ${event.eventId}`
    expect(dump.filter((d) => d.row.includes(TEAM))).toEqual([])
  } finally {
    await host.stop()
  }
})
