import { describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'
import { seedEvent, participantsOf } from './lib/stack.js'

const RUNNERS = [
  { firstName: 'Anna', lastName: 'Borowik', gender: 'K', club: 'KB Las' },
  { firstName: 'Piotr', lastName: 'Dąbek', club: 'KB Las' },
  { firstName: 'Ewa', lastName: 'Jodłowska', gender: 'K' },
]

describe('participants table', () => {
  test('a runner who handed the bib back is marked „Nie startuje”', async ({ app, agent, screen }) => {
    const { event, people } = await seedEvent({ name: 'E2E uczestnicy', runners: RUNNERS })
    const target = people[1]

    await app.open(`/events/${event.id}`)
    await screen.getByRole('tab', 'Uczestnicy').click()
    await agent.act('mark the runner with bib {bib} as not starting („Nie startuje”) and confirm', {
      params: { bib: String(target.bibNumber) },
    })

    await expect(screen.getByText('1 nie startuje')).toBeVisible()
    const after = await participantsOf(event.id)
    expect(after.find((p) => p.id === target.id).withdrawnAt).toBeTruthy()
    expect(after.filter((p) => p.withdrawnAt)).toHaveLength(1)
  })

  test('editing a club inline saves it to the backend', async ({ app, agent, screen }) => {
    const { event, people } = await seedEvent({ name: 'E2E klub', runners: RUNNERS })
    const target = people[2]

    await app.open(`/events/${event.id}`)
    await screen.getByRole('tab', 'Uczestnicy').click()
    await agent.act('set the club of the runner with bib {bib} to {club} in the table', {
      params: { bib: String(target.bibNumber), club: 'Leszy Team' },
    })

    await expect(screen.getByText('Leszy Team')).toBeVisible()
    await expect.poll(async () => (await participantsOf(event.id)).find((p) => p.id === target.id).club)
      .toBe('Leszy Team')
    const others = (await participantsOf(event.id)).filter((p) => p.id !== target.id)
    expect(others.map((p) => p.club)).toEqual(['KB Las', 'KB Las'])
  })
})
