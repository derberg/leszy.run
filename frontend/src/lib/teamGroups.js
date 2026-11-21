// Team labels and team order for the participants table. A team member is a participant
// with `teamId` (a registration team, or a relay team the operator set up). `names` comes from
// GET /events/:id/team-names: a registration team's name read from Supabase on request (never
// stored on the host), a host team's from host_teams. A team with no name (offline, a host team
// not named yet) is labelled by its members' surnames. `host` marks a team the operator may
// name: none of its members came from the online registration (backend lib/hostTeams.js).
const cmp = (a, b) => (a || '').localeCompare(b || '', 'pl', { sensitivity: 'base' })

export function teamLabels(participants, names = {}) {
  const members = new Map()
  for (const p of participants || []) {
    if (!p.teamId) continue
    if (!members.has(p.teamId)) members.set(p.teamId, [])
    members.get(p.teamId).push(p)
  }
  const labels = new Map()
  for (const [teamId, list] of members) {
    const surnames = [...list].sort(byLegThenName).map(p => p.lastName).filter(Boolean)
    labels.set(teamId, {
      name: names[teamId] || null,
      fallback: surnames.join(' · ') || '—',
      size: list.length,
      host: !list.some(p => p.registrationId),
    })
  }
  return labels
}

export const teamLabelText = (label) => label ? (label.name || label.fallback) : null

function byLegThenName(a, b) {
  return (a.teamLeg ?? Infinity) - (b.teamLeg ?? Infinity) || cmp(a.lastName, b.lastName) || cmp(a.firstName, b.firstName)
}

// Team members only, grouped by team (alphabetical by label), then by leg, then by name.
export function teamMembersByTeam(participants, labels) {
  const text = (p) => teamLabelText(labels.get(p.teamId))
  return (participants || [])
    .filter(p => p.teamId)
    .sort((a, b) => cmp(text(a), text(b)) || cmp(a.teamId, b.teamId) || byLegThenName(a, b))
}

// The teams a runner of `categoryId` can be moved to: every team that has a member in that
// category, by label. A team lives in one competition, so another category's teams are left out.
export function teamOptions(participants, labels, categoryId) {
  const ids = new Set((participants || []).filter(p => p.teamId && p.categoryId === categoryId).map(p => p.teamId))
  return [...ids]
    .map(teamId => ({ teamId, label: teamLabelText(labels.get(teamId)), size: labels.get(teamId)?.size ?? 0 }))
    .sort((a, b) => cmp(a.label, b.label) || cmp(a.teamId, b.teamId))
}

// A v4 UUID for a team made on the host. crypto.randomUUID() exists only in a secure context
// (HTTPS or localhost), and the admin panel is opened over plain http on `.local` and Tailscale
// addresses, so it is built from getRandomValues, which works everywhere.
export function newTeamId(cryptoObj = globalThis.crypto) {
  const b = cryptoObj.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// The leg a runner gets when moved into `teamId`: in a fixed-order relay the team's next free
// leg (a kept old leg would repeat or skip one, and the detector then times the team as
// individuals); otherwise none, since a relay in any order has no legs.
export function legAfterMove(participants, teamId, runnerId, fixedLeg) {
  if (!teamId || !fixedLeg) return null
  const legs = (participants || []).filter(p => p.teamId === teamId && p.id !== runnerId && p.teamLeg != null).map(p => p.teamLeg)
  return legs.length ? Math.max(...legs) + 1 : 1
}

// The longest host team name (host_teams CHECK, backend lib/hostTeams.js HOST_TEAM_NAME_MAX).
export const HOST_TEAM_NAME_MAX = 60

// The typed name as the backend stores it, or null when there is nothing to save: empty, too
// long or unchanged.
export function hostTeamNameToSave(typed, current) {
  const clean = String(typed ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim()
  if (!clean || [...clean].length > HOST_TEAM_NAME_MAX || clean === (current || '')) return null
  return clean
}
