// Names of relay teams set up on the host ("+ nowa drużyna" in the participants table), stored
// in host_teams and synced like categories. A registration team's name lives only in Supabase's
// `teams` and must never be stored on a host, so a team with any member who came from the online
// registration (participants.registration_id) cannot be named here: that decision needs no
// network, and results_team_names lets a `teams` row win over a host_teams row of the same id.
export const HOST_TEAM_NAME_MAX = 60
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The stored form of a typed name: trimmed, inner whitespace runs one space. null when not a string. */
export function normalizeHostTeamName(raw) {
  if (typeof raw !== 'string') return null
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

/** True when a team has a member from the online registration, so its name is not the host's. */
export const isRegistrationTeam = (members) => (members || []).some(p => p.registrationId)

/**
 * Why naming a host team is refused, or null with the name to store.
 * @param {{ eventId: string, teamId: string, name: unknown, members: Array<{registrationId?: string|null}>,
 *           existing?: { eventId: string }|null }} input  members: the event's live participants
 *           with that team_id; existing: the host_teams row already stored under that id
 * @returns {{ refusal: { status: number, error: string } } | { refusal: null, name: string }}
 */
export function hostTeamNameRefusal({ eventId, teamId, name, members, existing }) {
  const refuse = (status, error) => ({ refusal: { status, error } })
  if (!UUID_RE.test(String(eventId || '')) || !UUID_RE.test(String(teamId || ''))) return refuse(400, 'eventId and teamId must be UUIDs')
  const clean = normalizeHostTeamName(name)
  if (!clean) return refuse(400, 'Podaj nazwę drużyny.')
  if ([...clean].length > HOST_TEAM_NAME_MAX) return refuse(400, `Nazwa drużyny może mieć najwyżej ${HOST_TEAM_NAME_MAX} znaków.`)
  if (existing && existing.eventId !== eventId) return refuse(409, 'Ta drużyna należy do innego wydarzenia.')
  if (!members?.length) return refuse(404, 'Nie ma takiej drużyny w tym wydarzeniu.')
  if (isRegistrationTeam(members)) return refuse(409, 'Nazwę drużyny z zapisów zmienia kapitan lub organizator w zapisach.')
  return { refusal: null, name: clean }
}

/** Supabase's names, then this host's own, which win: a rename not pushed yet is the newest. */
export function mergeTeamNames(remote = {}, hostRows = []) {
  const names = { ...remote }
  for (const row of hostRows || []) if (row?.id && row.name) names[row.id] = row.name
  return names
}

/** Supabase's team_neutral_name(id): „Drużyna” and the first 8 characters of the id, upper case. */
export const neutralTeamName = (teamId) => `Drużyna ${String(teamId).slice(0, 8).toUpperCase()}`
