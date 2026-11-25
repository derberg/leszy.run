import { describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'
import { api, seedEvent, checkIn, publishReads, pass, resultsOf } from './lib/stack.js'

const RUNNERS = [
  { firstName: 'Anna', lastName: 'Borowik', gender: 'K' },
  { firstName: 'Piotr', lastName: 'Dąbek' },
  { firstName: 'Ewa', lastName: 'Jodłowska', gender: 'K' },
]

const activeRun = async (eventId) =>
  (await api.get(`/events/${eventId}/races`)).find((r) => r.status === 'active')

describe('race day', () => {
  test('a race started from race control times chip starts and finishes', async ({ app, agent, screen }) => {
    const { event, people } = await seedEvent({ name: 'E2E wyścig', runners: RUNNERS, minFinishSeconds: 5 })
    const [anna, piotr] = people // Ewa never crosses the line
    await checkIn(event.id, people)

    await app.open(`/events/${event.id}/race`)
    await agent.act('start the race for the 10 km category, confirming any dialog')
    await expect(screen.getByRole('button', 'Zatrzymaj wyścig')).toBeVisible()
    await expect.poll(() => activeRun(event.id).then(Boolean)).toBe(true)
    const run = await activeRun(event.id)

    // Start passes right after the gun, finish passes after min_finish_seconds.
    await publishReads([
      ...pass(anna.rfidEpc, 0), ...pass(piotr.rfidEpc, 200),
      ...pass(anna.rfidEpc, 6000), ...pass(piotr.rfidEpc, 7000),
    ])

    await expect.poll(async () => (await resultsOf(run.id)).filter((r) => r.status === 'finished').length,
      { timeout: 20_000 }).toBe(2)
    const results = await resultsOf(run.id)
    const byId = Object.fromEntries(results.map((r) => [r.participantId, r]))
    expect(byId[anna.id].startTimeSource).toBe('chip')
    expect(Date.parse(byId[anna.id].finishTime)).toBeLessThan(Date.parse(byId[piotr.id].finishTime))
    expect(byId[people[2].id].finishTime).toBeFalsy()

    await app.open(`/events/${event.id}/results`)
    await agent.assert('the live results („Przegląd trasy”) list Borowik first and Dąbek second as finished, and Jodłowska has no finish time')
  })

  test('an operator orders a chip tie by hand', async ({ app, agent, screen }) => {
    const { event, category, people } = await seedEvent({ name: 'E2E remis', runners: RUNNERS.slice(0, 2), minFinishSeconds: 5 })
    const [anna, piotr] = people
    const run = await api.post(`/categories/${category.id}/races`)

    // Anna's finish peak comes 100 ms before Piotr's: a tie the chip cannot order.
    await publishReads([
      ...pass(anna.rfidEpc, 0), ...pass(piotr.rfidEpc, 0),
      ...pass(anna.rfidEpc, 6000), ...pass(piotr.rfidEpc, 6100),
    ])
    await expect.poll(async () => (await resultsOf(run.id)).filter((r) => r.finishTime).length,
      { timeout: 20_000 }).toBe(2)

    await app.open(`/events/${event.id}/results`)
    await expect(screen.getByText('Remisy chipowe: 1')).toBeVisible()
    // The tie cell's text is the finish time, new every run: a cached agent tap on
    // it can never replay, so the popover is opened by its stable ⇅ marker.
    await screen.getByText(/⇅/).first().click()
    await agent.act('in the chip tie popover, put bib {bib} first', {
      params: { bib: String(piotr.bibNumber) },
    })

    await expect.poll(async () => {
      const rs = await resultsOf(run.id)
      const p = rs.find((r) => r.participantId === piotr.id)
      const a = rs.find((r) => r.participantId === anna.id)
      return p.manualOverride && Date.parse(p.finishTime) < Date.parse(a.finishTime)
    }).toBe(true)
    await expect(screen.getByText(/Remisy chipowe/)).toBeHidden()
  })
})
