import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTeamResults, teamRunners, formatTeamMs } from '../src/lib/teamResults.js'

const MIN = 60_000
let n = 0
const row = (teamId, leg, { gun = null, status, lastName = `R${++n}` } = {}) => ({
  id: `r${++n}`,
  participantId: `p${n}`,
  finishTime: gun != null ? new Date(gun).toISOString() : null,
  gunDurationMs: gun,
  status: status ?? (gun != null ? 'finished' : 'started'),
  participant: { teamId, teamLeg: leg, bibNumber: n, lastName },
})

test('relay: leg times are differences of brutto times, team time is the last leg', () => {
  const [t] = computeTeamResults({
    mode: 'relay',
    results: [row('A', 2, { gun: 21 * MIN }), row('A', 1, { gun: 10 * MIN }), row('A', 3, { gun: 33 * MIN })],
  })
  assert.equal(t.status, 'finished')
  assert.equal(t.totalMs, 33 * MIN)
  assert.deepEqual(t.members.map(m => [m.leg, m.legMs]), [[1, 10 * MIN], [2, 11 * MIN], [3, 12 * MIN]])
})

test('relay: ranking, gaps and per-leg ranks', () => {
  const teams = computeTeamResults({
    mode: 'relay',
    teamNames: { A: 'Alfa', B: 'Beta' },
    results: [
      row('A', 1, { gun: 10 * MIN }), row('A', 2, { gun: 22 * MIN }),
      row('B', 1, { gun: 11 * MIN }), row('B', 2, { gun: 21 * MIN }),
    ],
  })
  assert.deepEqual(teams.map(t => [t.name, t.position, t.gapMs]), [['Beta', 1, 0], ['Alfa', 2, MIN]])
  const beta = teams[0]
  assert.deepEqual(beta.members.map(m => m.legRank), [2, 1])
})

test('relay: a team on course ranks by legs done, then by its last handover', () => {
  const teams = computeTeamResults({
    mode: 'relay',
    results: [
      row('A', 1, { gun: 10 * MIN }), row('A', 2),
      row('B', 1, { gun: 9 * MIN }), row('B', 2),
      row('C', 1, { gun: 12 * MIN }), row('C', 2, { gun: 20 * MIN }),
    ],
  })
  assert.deepEqual(teams.map(t => [t.teamId, t.status, t.currentLeg]), [['C', 'finished', null], ['B', 'racing', 2], ['A', 'racing', 2]])
})

test('relay: a DNF on any leg sinks the team; DNS on leg 1 is a DNS team', () => {
  const teams = computeTeamResults({
    mode: 'relay',
    results: [
      row('A', 1, { gun: 10 * MIN }), row('A', 2, { status: 'dnf' }),
      row('B', 1, { status: 'dns' }), row('B', 2, { status: 'registered' }),
    ],
  })
  assert.deepEqual(teams.map(t => [t.teamId, t.status, t.position]), [['A', 'dnf', null], ['B', 'dns', null]])
})

test('relay: a missing handover leaves later legs without a leg time', () => {
  const [t] = computeTeamResults({
    mode: 'relay',
    results: [row('A', 1), row('A', 2, { gun: 22 * MIN })],
  })
  assert.equal(t.members[1].legMs, null, 'leg 2 has a brutto time but no known handover')
  assert.equal(t.status, 'racing')
})

test('rows without a team are ignored; default name comes from surnames', () => {
  const teams = computeTeamResults({
    mode: 'relay',
    results: [row(null, null, { gun: MIN }), row('A', 1, { lastName: 'Nowak' }), row('A', 2, { lastName: 'Kowalska' })],
  })
  assert.equal(teams.length, 1)
  assert.equal(teams[0].name, 'Nowak / Kowalska')
})

test('formatTeamMs', () => {
  assert.equal(formatTeamMs(null), '—')
  assert.equal(formatTeamMs(65_000), '1:05')
  assert.equal(formatTeamMs(3_725_000), '1:02:05')
})

const GUN = '2026-12-06T10:00:00.000Z'
// Laps of one team in running order: [[participantId, minutes], ...] → team_laps rows.
const lapsOf = (teamId, list) => {
  let t = new Date(GUN).getTime()
  return list.map(([participantId, min], i) => {
    t += min * MIN
    return { id: `${teamId}${i + 1}`, teamId, participantId, closedAt: new Date(t).toISOString() }
  })
}

test('relay_free with a fixed lap count: laps in any order, one runner may run several', () => {
  const a = row('A', null, { lastName: 'Nowak' }), b = row('A', null, { lastName: 'Lis' })
  const laps = lapsOf('A', [[a.participantId, 10], [a.participantId, 11], [b.participantId, 12]]).reverse() // order in the array does not matter
  const [t] = computeTeamResults({ mode: 'relay_free', lapCount: 3, results: [a, b], laps, gunStartedAt: GUN })
  assert.equal(t.status, 'finished')
  assert.equal(t.totalMs, 33 * MIN)
  assert.deepEqual(t.members.map(m => [m.leg, m.participant.lastName, m.legMs / MIN, m.cumulativeMs / MIN]),
    [[1, 'Nowak', 10, 10], [2, 'Nowak', 11, 21], [3, 'Lis', 12, 33]])
  assert.deepEqual(t.runners.map(r => [r.participant.lastName, r.laps, r.bestLapMs / MIN]), [['Nowak', 2, 10], ['Lis', 1, 12]])
})

test('relay_free: a deleted lap is skipped and the next one is timed from the lap before it', () => {
  const a = row('A', null)
  const laps = lapsOf('A', [[a.participantId, 10], [a.participantId, 1], [a.participantId, 10]])
  laps[1].deletedAt = '2026-12-06T11:00:00Z' // a false read, removed by the operator
  const [t] = computeTeamResults({ mode: 'relay_free', results: [{ ...a, status: 'started' }], laps, gunStartedAt: GUN })
  assert.deepEqual(t.members.map(m => [m.leg, m.legMs / MIN]), [[1, 10], [2, 11]])
})

test('relay_free, open-ended: most laps wins, then the earlier last lap; gaps in laps or time', () => {
  const a = row('A', null), b = row('B', null), c = row('C', null)
  const live = (r) => ({ ...r, status: 'started' })
  const teams = computeTeamResults({
    mode: 'relay_free', results: [live(a), live(b), live(c)], gunStartedAt: GUN,
    laps: [
      ...lapsOf('A', [[a.participantId, 10], [a.participantId, 10]]),
      ...lapsOf('B', [[b.participantId, 9], [b.participantId, 10], [b.participantId, 10]]),
      ...lapsOf('C', [[c.participantId, 10], [c.participantId, 11]]),
    ],
  })
  assert.deepEqual(teams.map(t => [t.teamId, t.position, t.completed, t.gapLaps, t.gapMs]),
    [['B', 1, 3, 0, 0], ['A', 2, 2, 1, null], ['C', 3, 2, 1, null]])
  assert.ok(teams.every(t => t.status === 'racing' && t.size === null))
  assert.deepEqual(teams.flatMap(t => t.members).map(m => m.legRank).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7])
})

test('relay_free: when the race is over every team with laps is finished; a team that gave up keeps its laps', () => {
  const a = row('A', null), b = row('B', null, { status: 'dnf' })
  const teams = computeTeamResults({
    mode: 'relay_free', raceFinished: true, gunStartedAt: GUN, results: [{ ...a, status: 'started' }, b],
    laps: [...lapsOf('A', [[a.participantId, 10]]), ...lapsOf('B', [[b.participantId, 9], [b.participantId, 9]])],
  })
  assert.deepEqual(teams.map(t => [t.teamId, t.status, t.position]), [['B', 'dnf', 1], ['A', 'finished', 2]])
})

test('teamRunners: best lap and most laps, across teams', () => {
  const a = row('A', null, { lastName: 'Nowak' }), b = row('A', null, { lastName: 'Lis' }), c = row('B', null, { lastName: 'Wrona' })
  const teams = computeTeamResults({
    mode: 'relay_free', results: [a, b, c], gunStartedAt: GUN,
    laps: [...lapsOf('A', [[a.participantId, 11], [a.participantId, 12], [b.participantId, 10]]), ...lapsOf('B', [[c.participantId, 9]])],
  })
  assert.deepEqual(teamRunners(teams, 'best').map(r => r.participant.lastName), ['Wrona', 'Lis', 'Nowak'])
  assert.deepEqual(teamRunners(teams, 'laps').map(r => [r.participant.lastName, r.laps]), [['Nowak', 2], ['Wrona', 1], ['Lis', 1]])
})

test('teamRunners in a fixed-order relay: every timed leg, fastest first', () => {
  const teams = computeTeamResults({
    mode: 'relay',
    results: [row('A', 1, { gun: 10 * MIN, lastName: 'Nowak' }), row('A', 2, { gun: 19 * MIN, lastName: 'Lis' }), row('A', 3, { lastName: 'Wrona' })],
  })
  assert.deepEqual(teamRunners(teams).map(r => [r.participant.lastName, r.bestLapMs / MIN, r.rank]), [['Lis', 9, 1], ['Nowak', 10, 2]])
})
