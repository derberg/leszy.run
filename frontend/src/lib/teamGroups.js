// Team labels and team order for the participants table. A team member is a participant
// with `teamId` (a registration team, or a relay team the operator set up). The host holds
// no team names: `names` comes from GET /events/:id/team-names, read from Supabase on
// request. A team with no name there (offline, a team made on the host) is labelled by its
// members' surnames, as the relay panel on Wyniki does.
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
    labels.set(teamId, { name: names[teamId] || null, fallback: surnames.join(' · ') || '—', size: list.length })
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
