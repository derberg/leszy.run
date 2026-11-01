import { test, expect, ACTOR_EMAILS } from './fixtures.js'
import { admin, resetThrottle, sessionFor } from '../helpers/stack.js'
import { callFn, createPublishedFreeEvent } from '../helpers/registrationFixtures.js'
import { STAFETA, freeTeamEvent, setLegOrder, teamOk } from '../helpers/teams.js'
import { BIEG } from '../helpers/groups.js'

// Plan 5 task 6: the organizer wizard for teams. T-50 (A3: „Drużyna”, the size,
// the units, the event limit, a staged size after a reload), T-51 (A5: the relay
// section, leg order staged whole and only when it differs), T-52 (A8: a team
// locks kind, size and leg order).

const ZT = '00000000-0000-4000-8000-0000000000c1'
const TIP = 'Kapitan ustala kolejność zmian i może ją zmieniać do ostatniego dnia zapisów. Wyłączone: kolejność nie jest zbierana, pomiar LESZY.RUN jej nie potrzebuje.'

test.describe.configure({ mode: 'serial' })

// organizer-gate.spec.js removes the seed club's agreement when it finishes.
test.beforeAll(async () => {
  await resetThrottle()
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const { body } = await callFn('organizer-status', owner, { clubId: ZT })
  if (!body.data.agreementAccepted) await callFn('accept-organizer-agreement', owner, { clubId: ZT, version: body.data.version })
})

async function competitionsOf(eventId) {
  const { data, error } = await admin().from('competitions').select('*').eq('event_id', eventId).order('sort_order')
  if (error) throw error
  return data
}

async function stagedOf(eventId) {
  const { data, error } = await admin().from('registration_pending_changes').select('payload').eq('event_id', eventId).maybeSingle()
  if (error) throw error
  return data?.payload ?? null
}

const stepUrl = (eventId, step) => `/klub/zatyrani-test/wydarzenia/${eventId}/${step}`

async function draftEvent() {
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const r = await callFn('create-registration-event', owner, { clubId: ZT, name: `Sztafeta Leszego ${Date.now()}` })
  return r.body.data.eventId
}

test('T-50 A3: a team competition, its size, units and fee; the event limit splits people and teams', async ({ actors }) => {
  const eventId = await draftEvent()
  const page = await actors.owner.newPage()
  await page.goto(stepUrl(eventId, 'konkurencje'))

  await page.getByRole('button', { name: '+ Konkurencja' }).click()
  await page.getByLabel('Nazwa konkurencji 1').fill('Bieg 9 km')
  await page.getByLabel('Limit 1').fill('200')
  await page.getByRole('button', { name: '+ Konkurencja' }).click()
  await page.getByLabel('Nazwa konkurencji 2').fill('Sztafeta')
  await page.getByLabel('Limit 2').fill('20')
  await expect(page.getByTestId('team-size')).toHaveCount(0)

  await page.getByLabel('Rodzaj 2').selectOption('team')
  const row = page.getByTestId('competition-row').nth(1)
  await expect(row.getByTestId('team-size')).toContainText('OSÓB')
  await expect(row.getByTestId('capacity-unit')).toHaveText('DRUŻYN')
  await expect(page.getByTestId('event-capacity')).toHaveText('200 OSÓB + 20 DRUŻYN')
  await expect(page.getByText('Skład: od 2 do 10 osób')).toBeVisible()
  await page.getByLabel('Skład od 2').fill('2')
  await page.getByLabel('Skład do 2').fill('6')
  await expect.poll(async () => (await competitionsOf(eventId)).map((c) => [c.name, c.kind, c.team_min, c.team_max, c.capacity]),
    { timeout: 15_000 }).toEqual([['Bieg 9 km', 'individual', null, null, 200], ['Sztafeta', 'team', 2, 6, 20]])

  await page.getByRole('radio', { name: 'Stała' }).check()
  const prices = page.getByTestId('prices').locator('tbody tr')
  await expect(prices.nth(1)).toContainText('ZA DRUŻYNĘ')
  await expect(prices.nth(0)).not.toContainText('ZA DRUŻYNĘ')
  await page.getByRole('radio', { name: 'Bezpłatne' }).check()

  // A later save of another row must not flip the team back.
  await page.getByLabel('Limit 1').fill('210')
  await expect.poll(async () => (await competitionsOf(eventId)).map((c) => [c.kind, c.capacity]), { timeout: 15_000 })
    .toEqual([['individual', 210], ['team', 20]])
  await page.reload()
  await expect(page.getByLabel('Rodzaj 2')).toHaveValue('team')
  await expect(page.getByLabel('Skład do 2')).toHaveValue('6')
  await expect(page.getByTestId('event-capacity')).toHaveText('210 OSÓB + 20 DRUŻYN')
  await page.close()
})

test('T-50 A8: a staged team size survives a reload (P2-R25) and is a row of the bar', async ({ actors }) => {
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const { eventId, categoryIds } = await freeTeamEvent(owner)
  const page = await actors.owner.newPage()
  await page.goto(stepUrl(eventId, 'konkurencje'))

  await page.getByLabel('Skład do 1').fill('8')
  await expect.poll(async () => (await stagedOf(eventId))?.competitions?.items?.[0]?.team_max, { timeout: 15_000 }).toBe(8)
  expect((await competitionsOf(eventId))[0].team_max).toBe(6)
  await expect(page.getByTestId('pending-bar')).toContainText('Sztafeta: skład do')
  await page.reload()
  await expect(page.getByLabel('Skład do 1')).toHaveValue('8')
  await expect(page.getByLabel('Rodzaj 1')).toHaveValue('team')
  expect((await competitionsOf(eventId))[0].category_id).toBe(categoryIds[0])
  await page.close()
})

test('T-51 A5: the relay section; a draft saves leg order straight, Nie by default', async ({ actors }) => {
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const eventId = await draftEvent()
  const page = await actors.owner.newPage()

  await page.goto(stepUrl(eventId, 'formularz'))
  await expect(page.getByTestId('form-fields')).toBeVisible()
  await expect(page.getByTestId('team-section')).toHaveCount(0)

  const { body } = await callFn('save-registration-section', owner, { eventId, section: 'competitions', value: {
    pricingMode: 'free', items: [{ ...BIEG(), kind: 'individual' }, STAFETA(20)],
  } })
  await page.reload()
  const section = page.getByTestId('team-section')
  await expect(section).toHaveCount(1)
  await expect(section.getByRole('heading', { name: 'Sztafeta' })).toBeVisible()
  await expect(section.getByText('Nazwa drużyny')).toBeVisible()
  await expect(section.getByText('ZAWSZE')).toBeVisible()
  const group = section.getByRole('group', { name: 'Kolejność zmian: Sztafeta' })
  await expect(group.getByRole('button', { name: 'Nie' })).toHaveAttribute('aria-pressed', 'true')
  await section.getByRole('button', { name: 'Co oznacza kolejność zmian' }).click()
  await expect(page.getByTestId('leg-order-tip')).toHaveText(TIP)

  await group.getByRole('button', { name: 'Zbieraj' }).click()
  await expect.poll(async () => (await competitionsOf(eventId)).find((c) => c.kind === 'team').leg_order_enabled, { timeout: 15_000 }).toBe(true)
  await group.getByRole('button', { name: 'Nie' }).click()
  await expect.poll(async () => (await competitionsOf(eventId)).find((c) => c.kind === 'team').leg_order_enabled, { timeout: 15_000 }).toBe(false)
  await page.reload()
  await expect(section.getByRole('group', { name: 'Kolejność zmian: Sztafeta' }).getByRole('button', { name: 'Nie' })).toHaveAttribute('aria-pressed', 'true')
  expect(body.data.categoryIds.length).toBe(2)
  await page.close()
})

test('T-51 A8: leg order is staged as the full map, shown after a reload, and only when it differs', async ({ actors }) => {
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const { eventId, categoryIds: [a, b] } = await createPublishedFreeEvent(owner, { competitions: [
    STAFETA(20, { name: 'Sztafeta A' }), STAFETA(20, { name: 'Sztafeta B' }),
  ] })
  await setLegOrder(b, true)
  const page = await actors.owner.newPage()
  await page.goto(stepUrl(eventId, 'formularz'))
  await expect(page.getByTestId('team-section')).toHaveCount(2)

  // A field change alone sends no leg order: an identical map would count as a change.
  await page.getByRole('group', { name: 'Miejscowość' }).getByRole('button', { name: 'Wymagane' }).click()
  await expect.poll(async () => (await stagedOf(eventId))?.form?.form_fields?.city, { timeout: 15_000 }).toBe('required')
  expect('leg_order' in (await stagedOf(eventId)).form).toBe(false)

  await page.getByRole('group', { name: 'Kolejność zmian: Sztafeta A' }).getByRole('button', { name: 'Zbieraj' }).click()
  await expect.poll(async () => (await stagedOf(eventId))?.form?.leg_order, { timeout: 15_000 }).toEqual({ [a]: true, [b]: true })
  expect((await competitionsOf(eventId)).map((c) => c.leg_order_enabled).sort()).toEqual([false, true])
  await expect(page.getByTestId('pending-bar')).toContainText('Sztafeta A: kolejność zmian')

  await page.reload()
  const groupA = page.getByRole('group', { name: 'Kolejność zmian: Sztafeta A' })
  await expect(groupA.getByRole('button', { name: 'Zbieraj' })).toHaveAttribute('aria-pressed', 'true')

  // Back to the live value: the staged map must follow, or publish would apply it.
  await groupA.getByRole('button', { name: 'Nie' }).click()
  await expect.poll(async () => (await stagedOf(eventId))?.form?.leg_order, { timeout: 15_000 }).toEqual({ [a]: false, [b]: true })
  await expect(page.getByTestId('pending-bar')).not.toContainText('kolejność zmian')
  await page.close()
})

test('T-52 A8: a registered team locks kind, size and leg order', async ({ actors }) => {
  const owner = await sessionFor(ACTOR_EMAILS.owner)
  const event = await freeTeamEvent(owner)
  await teamOk(event)
  const page = await actors.owner.newPage()

  await page.goto(stepUrl(event.eventId, 'konkurencje'))
  const row = page.getByTestId('competition-row').first()
  await expect(page.getByLabel('Rodzaj 1')).toBeDisabled()
  await expect(page.getByLabel('Rodzaj 1')).toHaveValue('team')
  await expect(row.getByRole('img', { name: /rodzaju nie można zmienić/ })).toBeVisible()
  await expect(page.getByLabel('Skład od 1')).toBeDisabled()
  await expect(page.getByLabel('Skład do 1')).toBeDisabled()
  await expect(row.getByRole('img', { name: /składu nie można zmienić/ })).toBeVisible()
  await expect(row.getByTestId('capacity-min')).toHaveText('MIN. 1')

  // A staged edit elsewhere keeps the lock: the staged list has no inUse of its own.
  await page.getByLabel('Start 1').fill('10:15')
  await expect.poll(async () => (await stagedOf(event.eventId))?.competitions?.items?.[0]?.start_time, { timeout: 15_000 }).toBe('10:15')
  await page.reload()
  await expect(page.getByLabel('Start 1')).toHaveValue('10:15')
  await expect(page.getByLabel('Skład do 1')).toBeDisabled()

  await page.goto(stepUrl(event.eventId, 'formularz'))
  const group = page.getByRole('group', { name: 'Kolejność zmian: Sztafeta' })
  await expect(group.getByRole('button', { name: 'Zbieraj' })).toBeDisabled()
  await expect(group.getByRole('button', { name: 'Nie' })).toBeDisabled()
  await expect(page.getByTestId('team-section').getByRole('img', { name: /kolejności zmian nie można zmienić/ })).toBeVisible()
  await page.close()
})
