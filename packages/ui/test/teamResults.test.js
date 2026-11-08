import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTeamResults, formatTeamMs } from '../src/lib/teamResults.js'

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

test('together: team time is the last member in; spread is first to last', () => {
  const [t] = computeTeamResults({
    mode: 'together',
    results: [row('A', null, { gun: 30 * MIN }), row('A', null, { gun: 31 * MIN }), row('A', null, { gun: 33 * MIN })],
  })
  assert.equal(t.totalMs, 33 * MIN)
  assert.equal(t.spreadMs, 3 * MIN)
})

test('together: countMembers counts the best N, a DNF beyond them does not sink the team', () => {
  const [t] = computeTeamResults({
    mode: 'together',
    countMembers: 3,
    results: [
      row('A', null, { gun: 30 * MIN }), row('A', null, { gun: 31 * MIN }),
      row('A', null, { gun: 32 * MIN }), row('A', null, { status: 'dnf' }),
    ],
  })
  assert.equal(t.status, 'finished')
  assert.equal(t.totalMs, 32 * MIN)
  assert.equal(t.members.filter(m => m.counted).length, 3)
})

test('together: two DNFs out of four with countMembers 3 is a DNF team', () => {
  const [t] = computeTeamResults({
    mode: 'together',
    countMembers: 3,
    results: [row('A', null, { gun: 30 * MIN }), row('A', null), row('A', null, { status: 'dnf' }), row('A', null, { status: 'dnf' })],
  })
  assert.equal(t.status, 'dnf')
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

const lap = (teamId, lapNumber, participantId, min) => ({ id: `${teamId}${lapNumber}`, teamId, lapNumber, participantId, lapMs: min * MIN })

test('relay_free: laps in any order, one runner may run several', () => {
  const a = row('A', null, { lastName: 'Nowak' }), b = row('A', null, { lastName: 'Lis' })
  const [t] = computeTeamResults({
    mode: 'relay_free', lapCount: 3, results: [a, b],
    laps: [lap('A', 2, a.participantId, 11), lap('A', 1, a.participantId, 10), lap('A', 3, b.participantId, 12)],
  })
  assert.equal(t.status, 'finished')
  assert.equal(t.totalMs, 33 * MIN)
  assert.deepEqual(t.members.map(m => [m.leg, m.participant.lastName, m.cumulativeMs / MIN]), [[1, 'Nowak', 10], [2, 'Nowak', 21], [3, 'Lis', 33]])
  assert.deepEqual(t.runners.map(r => [r.participant.lastName, r.laps, r.bestLapMs / MIN]), [['Nowak', 2, 10], ['Lis', 1, 12]])
})

test('relay_free: short of the lap count is still racing, laps ranked race-wide', () => {
  const a = row('A', null), b = row('B', null)
  const teams = computeTeamResults({
    mode: 'relay_free', lapCount: 2, results: [{ ...a, status: 'started' }, { ...b, status: 'started' }],
    laps: [lap('A', 1, a.participantId, 12), lap('B', 1, b.participantId, 10), lap('B', 2, b.participantId, 11)],
  })
  assert.deepEqual(teams.map(t => [t.teamId, t.status, t.currentLeg]), [['B', 'finished', null], ['A', 'racing', 2]])
  assert.deepEqual(teams.flatMap(t => t.members).map(m => m.legRank).sort(), [1, 2, 3])
})
