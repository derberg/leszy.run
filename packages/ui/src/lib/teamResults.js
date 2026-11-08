/**
 * Team standings for a team category, derived from the members' own results and laps.
 *
 * Every member of a team carries their own tag and bib; the team is never timed by a tag of
 * its own. Its standing is computed here, so an operator's correction re-derives the team
 * without anything stored.
 *
 * Two modes:
 *  - 'relay' (sztafeta, stała kolejność): members run one after another in leg order. Leg 1
 *    starts at the gun, leg k when leg k-1 finishes. A leg's time is the difference between the
 *    two brutto times; the team's time is the last leg's brutto time. Ranked by that time.
 *  - 'relay_free' (sztafeta, dowolna kolejność, the default): the team runs laps in any order,
 *    one member may run several. Each lap comes from `laps` (team_laps rows), credited to whoever
 *    closed it. Ranked by laps done (most first), then by when the last of them was closed
 *    (earliest first). `lapCount` caps the laps when the race has a fixed number; without it the
 *    team runs as many as it can (Sztafeta Mikołajów). `members` are the laps in order, `runners`
 *    sums them per person.
 *
 * @param {object}   opts
 * @param {'relay'|'relay_free'} opts.mode
 * @param {Array}    opts.results  result rows: { id, participantId, finishTime, gunDurationMs,
 *                                 status, participant: { bibNumber, firstName, lastName, teamId,
 *                                 teamLeg } }. Rows without participant.teamId are ignored.
 * @param {Object<string,string>} [opts.teamNames] teamId → display name; missing ones get a
 *                                 label from the members' surnames
 * @param {Array}    [opts.laps]  'relay_free': team_laps rows { id, teamId, participantId, closedAt,
 *                                 deletedAt?, source? }. A lap's number and time are derived: the
 *                                 team's live laps in closedAt order, each timed from the one before
 *                                 (the first from the gun).
 * @param {string|Date} [opts.gunStartedAt] 'relay_free': the race run's gun
 * @param {number}   [opts.lapCount] 'relay_free': a fixed number of laps; none = as many as possible
 * @param {boolean}  [opts.raceFinished] the race run is over: every team still running is done
 * @returns {Array<TeamStanding>} sorted by standing
 *
 * @typedef {object} TeamStanding
 * @property {string} teamId
 * @property {string} name
 * @property {'finished'|'racing'|'not-started'|'dnf'|'dsq'|'dns'} status
 * @property {number|null} position
 * @property {number|null} totalMs       relay: the team's time; relay_free: when its last lap closed
 * @property {number|null} gapMs         behind the leader (relay_free: only on the same lap count)
 * @property {number|null} gapLaps       relay_free: laps behind the leader
 * @property {number} completed          legs or laps done
 * @property {number|null} size          legs, or the fixed lap count (null: open)
 * @property {number|null} currentLeg    the leg or lap on course now
 * @property {Array} members             legs or laps: { leg, legMs, legRank, cumulativeMs, participant }
 * @property {Array} [runners]           relay_free: each member with { laps, bestLapMs }
 */
const UNRANKED_TEAM = { dnf: 1, dsq: 2, dns: 3 }
const STATUS_ORDER = { finished: 0, racing: 1, 'not-started': 2, dnf: 3, dsq: 4, dns: 5 }

export function computeTeamResults({ mode, results, teamNames = {}, laps = [], lapCount, raceFinished = false, gunStartedAt = null } = {}) {
  const byTeam = new Map()
  for (const r of results ?? []) {
    const teamId = r.participant?.teamId
    if (!teamId) continue
    if (!byTeam.has(teamId)) byTeam.set(teamId, [])
    byTeam.get(teamId).push(r)
  }
  const lapsByTeam = new Map()
  for (const l of laps) {
    if (l.deletedAt) continue
    if (!lapsByTeam.has(l.teamId)) lapsByTeam.set(l.teamId, [])
    lapsByTeam.get(l.teamId).push(l)
  }

  const free = mode === 'relay_free'
  const teams = [...byTeam].map(([teamId, rows]) => free
    ? freeRelayTeam(teamId, rows, lapsByTeam.get(teamId) ?? [], lapCount, raceFinished, gunStartedAt)
    : relayTeam(teamId, rows))

  for (const t of teams) t.name = teamNames[t.teamId] || defaultTeamName(t.runners ?? t.members)

  if (free) {
    rankAllLaps(teams)
    teams.sort(compareFree)
    const leader = teams.find(isRankedFree)
    let pos = 0
    for (const t of teams) {
      const ranked = isRankedFree(t)
      t.position = ranked ? ++pos : null
      t.gapLaps = ranked && leader ? leader.completed - t.completed : null
      t.gapMs = ranked && leader && t.gapLaps === 0 ? t.totalMs - leader.totalMs : null
    }
    return teams
  }

  rankLegs(teams)
  teams.sort(compareTeams)
  const leader = teams.find(t => t.status === 'finished')
  let pos = 0
  for (const t of teams) {
    t.position = t.status === 'finished' ? ++pos : null
    t.gapMs = t.status === 'finished' && leader ? t.totalMs - leader.totalMs : null
    t.gapLaps = null
  }
  return teams
}

/**
 * One row per runner across every team, for the individual views. In a relay in any order a
 * runner's own laps are summed; in a fixed-order relay each runner has one leg.
 * by: 'best' (fastest lap or leg first) or 'laps' (most laps, then the fastest best lap).
 * Runners with no timed lap or leg are left out.
 */
export function teamRunners(teams, by = 'best') {
  const rows = teams.flatMap(t => (t.runners
    ?? t.members.filter(m => m.legMs != null).map(m => ({ ...m, laps: 1, bestLapMs: m.legMs })))
    .filter(r => r.laps > 0)
    .map(r => ({ ...r, teamId: t.teamId, teamName: t.name })))
  rows.sort(by === 'laps'
    ? (a, b) => b.laps - a.laps || a.bestLapMs - b.bestLapMs
    : (a, b) => a.bestLapMs - b.bestLapMs || b.laps - a.laps)
  rows.forEach((r, i) => { r.rank = i + 1 })
  return rows
}

function relayTeam(teamId, rows) {
  const members = [...rows]
    .sort((a, b) => (a.participant.teamLeg ?? Infinity) - (b.participant.teamLeg ?? Infinity))
    .map((r, i) => ({ ...r, leg: r.participant.teamLeg ?? i + 1 }))

  let prevCum = 0
  let chainBroken = false
  let completed = 0
  for (const m of members) {
    const cum = isTimed(m) ? m.gunDurationMs : null
    // A leg's time needs the previous leg's finish: without it the handover is unknown.
    m.cumulativeMs = cum
    m.legMs = cum != null && !chainBroken ? cum - prevCum : null
    if (cum == null) chainBroken = true
    else { prevCum = cum; if (!chainBroken) completed++ }
  }

  const status = teamStatus(members, {
    allDone: completed === members.length,
    anyStarted: members.some(m => m.startTime || m.finishTime || m.status === 'started' || m.status === 'finished'),
    firstLegDns: members[0]?.status === 'dns',
  })
  const last = members[members.length - 1]
  return {
    teamId,
    status,
    totalMs: status === 'finished' ? last.cumulativeMs : null,
    completed,
    size: members.length,
    currentLeg: status === 'racing' ? Math.min(completed + 1, members.length) : null,
    // For ordering teams still on course: the later the leg and the earlier its handover, the better.
    lastSplitMs: completed ? members[completed - 1].cumulativeMs : null,
    members,
  }
}

function freeRelayTeam(teamId, rows, teamLaps, lapCount, raceFinished, gunStartedAt) {
  const byPid = new Map(rows.map(r => [r.participantId, r]))
  const gun = gunStartedAt ? new Date(gunStartedAt).getTime() : null
  const ordered = [...teamLaps].sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt))
  const counted = lapCount ? ordered.slice(0, lapCount) : ordered
  let prev = gun
  const members = counted.map((l, i) => {
    const at = new Date(l.closedAt).getTime()
    const legMs = prev != null ? at - prev : null
    prev = at
    const r = byPid.get(l.participantId)
    return { id: l.id ?? `${teamId}:${i + 1}`, lapId: l.id ?? null, participantId: l.participantId, participant: r?.participant ?? {},
      status: 'finished', leg: i + 1, legMs, cumulativeMs: gun != null ? at - gun : null, closedAt: l.closedAt, source: l.source ?? 'chip' }
  })
  const cum = members.length ? members[members.length - 1].cumulativeMs : null
  const runners = rows.map(r => {
    const own = members.filter(m => m.participantId === r.participantId)
    const timed = own.filter(m => m.legMs != null)
    return { ...r, laps: own.length, bestLapMs: timed.length ? Math.min(...timed.map(m => m.legMs)) : null }
  }).sort((a, b) => b.laps - a.laps || (a.bestLapMs ?? Infinity) - (b.bestLapMs ?? Infinity))

  const completed = members.length
  const gaveUp = rows.length > 0 && rows.every(r => r.status === 'dnf' || r.status === 'dns') && rows.some(r => r.status === 'dnf')
  let status
  if (rows.some(r => r.status === 'dsq')) status = 'dsq'
  else if (lapCount && completed >= lapCount) status = 'finished'
  else if (!completed && rows.every(r => r.status === 'dns')) status = 'dns'
  else if (gaveUp) status = 'dnf'
  else if (raceFinished) status = completed ? 'finished' : 'dns'
  else status = completed || rows.some(r => r.startTime || r.status === 'started') ? 'racing' : 'not-started'

  return {
    teamId,
    status,
    totalMs: completed ? cum : null,
    completed,
    size: lapCount ?? null,
    currentLeg: status === 'racing' ? completed + 1 : null,
    lastSplitMs: completed ? cum : null,
    members,
    runners,
  }
}

// A relay in any order ranks every team that has done a lap and is not disqualified, also one
// that gave up: its laps still count, as in a timed relay.
const isRankedFree = (t) => t.completed > 0 && t.status !== 'dsq'

function compareFree(a, b) {
  const ra = isRankedFree(a), rb = isRankedFree(b)
  if (ra !== rb) return ra ? -1 : 1
  if (ra) return b.completed - a.completed || a.totalMs - b.totalMs
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name, 'pl')
}

// Relay in any order: every lap of the race ranked against every other (Najszybsze okrążenia).
function rankAllLaps(teams) {
  for (const t of teams) for (const m of t.members) m.legRank = null
  const all = teams.flatMap(t => t.members).filter(m => m.legMs != null).sort((a, b) => a.legMs - b.legMs)
  all.forEach((m, i) => { m.legRank = i + 1 })
}

function teamStatus(members, { allDone, anyStarted, firstLegDns }) {
  if (members.some(m => m.status === 'dsq')) return 'dsq'
  if (allDone) return 'finished'
  if (firstLegDns) return 'dns'
  if (members.some(m => m.status === 'dnf' || m.status === 'dns')) return 'dnf'
  return anyStarted ? 'racing' : 'not-started'
}

const isTimed = (r) => r.finishTime != null && r.gunDurationMs != null && !UNRANKED_TEAM[r.status]

function rankLegs(teams) {
  const legs = new Map()
  for (const t of teams) for (const m of t.members) {
    if (m.legMs == null) continue
    if (!legs.has(m.leg)) legs.set(m.leg, [])
    legs.get(m.leg).push(m)
  }
  for (const list of legs.values()) {
    list.sort((a, b) => a.legMs - b.legMs).forEach((m, i) => { m.legRank = i + 1 })
  }
  for (const t of teams) for (const m of t.members) if (m.legRank === undefined) m.legRank = null
}

function compareTeams(a, b) {
  const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  if (s) return s
  if (a.status === 'finished') return a.totalMs - b.totalMs
  if (a.status === 'racing') {
    if (a.completed !== b.completed) return b.completed - a.completed
    return (a.lastSplitMs ?? Infinity) - (b.lastSplitMs ?? Infinity)
  }
  return a.name.localeCompare(b.name, 'pl')
}

function defaultTeamName(members) {
  const names = [...new Set(members.map(m => m.participant?.lastName).filter(Boolean))]
  if (!names.length) return 'Drużyna'
  return names.length > 2 ? `${names[0]} i in.` : names.join(' / ')
}

/** h:mm:ss or m:ss, the format the results tables use. */
export function formatTeamMs(ms) {
  if (ms == null) return '—'
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
