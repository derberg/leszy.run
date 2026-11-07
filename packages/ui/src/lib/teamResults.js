/**
 * Team standings for a team category, derived from the members' individual results.
 *
 * Every member of a team carries their own tag and bib and keeps their own result row; the
 * team is never timed by a tag of its own. Its standing is computed here from those rows, so
 * an operator's edit of one member's finish re-derives the team without anything stored.
 *
 * Two modes:
 *  - 'relay' (sztafeta): members run one after another in leg order. Leg 1 starts at the gun,
 *    leg k starts when leg k-1 finishes (the handover at the gate). A leg's time is the
 *    difference between the two brutto times; the team's time is the last leg's brutto time.
 *  - 'together' (bieg drużynowy): all members start at the gun and run together. The team's time
 *    is the brutto time of its `countMembers`-th finisher (default: every member, i.e. the last
 *    one in), and `spreadMs` is how far apart its counted members came in.
 *
 * @param {object}   opts
 * @param {'relay'|'together'} opts.mode
 * @param {Array}    opts.results  result rows: { id, participantId, finishTime, durationMs,
 *                                 gunDurationMs, status, participant: { bibNumber, firstName,
 *                                 lastName, teamId, teamLeg } }. Rows without participant.teamId
 *                                 are ignored.
 * @param {Object<string,string>} [opts.teamNames] teamId → display name; missing ones get a
 *                                 label from the members' surnames
 * @param {number}   [opts.countMembers] 'together' only: how many finishers make the team time
 * @returns {Array<TeamStanding>} sorted by standing
 *
 * @typedef {object} TeamStanding
 * @property {string} teamId
 * @property {string} name
 * @property {'finished'|'racing'|'not-started'|'dnf'|'dsq'|'dns'} status
 * @property {number|null} position      only for 'finished'
 * @property {number|null} totalMs       brutto team time, finished teams only
 * @property {number|null} gapMs         behind the leading team
 * @property {number} completed          legs (relay) or members (together) finished
 * @property {number} size
 * @property {number|null} currentLeg    relay: the leg on course now
 * @property {number|null} spreadMs      together: first to last counted member
 * @property {Array} members             each row plus { leg, legMs, legRank, cumulativeMs, counted }
 */
const UNRANKED_TEAM = { dnf: 1, dsq: 2, dns: 3 }
const STATUS_ORDER = { finished: 0, racing: 1, 'not-started': 2, dnf: 3, dsq: 4, dns: 5 }

export function computeTeamResults({ mode, results, teamNames = {}, countMembers } = {}) {
  const byTeam = new Map()
  for (const r of results ?? []) {
    const teamId = r.participant?.teamId
    if (!teamId) continue
    if (!byTeam.has(teamId)) byTeam.set(teamId, [])
    byTeam.get(teamId).push(r)
  }

  const teams = [...byTeam].map(([teamId, rows]) =>
    mode === 'relay' ? relayTeam(teamId, rows) : togetherTeam(teamId, rows, countMembers))

  for (const t of teams) t.name = teamNames[t.teamId] || defaultTeamName(t.members)

  if (mode === 'relay') rankLegs(teams)

  teams.sort(compareTeams)
  const leader = teams.find(t => t.status === 'finished')
  let pos = 0
  for (const t of teams) {
    t.position = t.status === 'finished' ? ++pos : null
    t.gapMs = t.status === 'finished' && leader ? t.totalMs - leader.totalMs : null
  }
  return teams
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
    m.counted = true
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
    spreadMs: null,
    members,
  }
}

function togetherTeam(teamId, rows, countMembers) {
  const members = [...rows].map(r => ({ ...r, leg: null, legMs: null, legRank: null, cumulativeMs: isTimed(r) ? r.gunDurationMs : null }))
  const need = Math.min(countMembers ?? members.length, members.length)
  const finishers = members.filter(m => m.cumulativeMs != null).sort((a, b) => a.cumulativeMs - b.cumulativeMs)
  const counted = new Set(finishers.slice(0, need).map(m => m.id))
  for (const m of members) m.counted = counted.has(m.id)
  members.sort((a, b) => (a.cumulativeMs ?? Infinity) - (b.cumulativeMs ?? Infinity)
    || (a.participant.bibNumber ?? Infinity) - (b.participant.bibNumber ?? Infinity))

  const done = finishers.length >= need
  // With countMembers below the squad size a member's DNF does not sink the team, as long as
  // enough others finished.
  const status = done
    ? (members.some(m => m.status === 'dsq') ? 'dsq' : 'finished')
    : teamStatus(members, {
        allDone: false,
        anyStarted: members.some(m => m.startTime || m.finishTime || m.status === 'started' || m.status === 'finished'),
        firstLegDns: members.every(m => m.status === 'dns'),
        // A team that can still reach `need` finishers is still racing.
        stillPossible: members.filter(m => !UNRANKED_TEAM[m.status]).length >= need,
      })
  const countedTimes = finishers.slice(0, need).map(m => m.cumulativeMs)
  return {
    teamId,
    status,
    totalMs: status === 'finished' ? countedTimes[countedTimes.length - 1] : null,
    completed: finishers.length,
    size: members.length,
    currentLeg: null,
    lastSplitMs: finishers.length ? finishers[finishers.length - 1].cumulativeMs : null,
    spreadMs: done && countedTimes.length > 1 ? countedTimes[countedTimes.length - 1] - countedTimes[0] : null,
    members,
  }
}

function teamStatus(members, { allDone, anyStarted, firstLegDns, stillPossible = false }) {
  if (members.some(m => m.status === 'dsq')) return 'dsq'
  if (allDone) return 'finished'
  if (firstLegDns) return 'dns'
  if (!stillPossible && members.some(m => m.status === 'dnf' || m.status === 'dns')) return 'dnf'
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
