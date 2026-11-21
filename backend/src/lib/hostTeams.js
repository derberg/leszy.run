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
 *           existing?: { eventId: string }|null, registrationTeam?: boolean }} input  members: the
 *           event's live participants with that team_id; existing: the host_teams row already
 *           stored under that id; registrationTeam: Supabase has a `teams` row with that id
 * @returns {{ refusal: { status: number, error: string } } | { refusal: null, name: string }}
 */
export function hostTeamNameRefusal({ eventId, teamId, name, members, existing, registrationTeam = false }) {
  const refuse = (status, error) => ({ refusal: { status, error } })
  if (!UUID_RE.test(String(eventId || '')) || !UUID_RE.test(String(teamId || ''))) return refuse(400, 'eventId and teamId must be UUIDs')
  const clean = normalizeHostTeamName(name)
  if (!clean) return refuse(400, 'Podaj nazwę drużyny.')
  if ([...clean].length > HOST_TEAM_NAME_MAX) return refuse(400, `Nazwa drużyny może mieć najwyżej ${HOST_TEAM_NAME_MAX} znaków.`)
  if (existing && existing.eventId !== eventId) return refuse(409, 'Ta drużyna należy do innego wydarzenia.')
  if (!members?.length) return refuse(404, 'Nie ma takiej drużyny w tym wydarzeniu.')
  if (registrationTeam || isRegistrationTeam(members)) return refuse(409, 'Nazwę drużyny z zapisów zmienia kapitan lub organizator w zapisach.')
  return { refusal: null, name: clean }
}

/**
 * The event's team names. A registration team's name always comes from Supabase: a host row under
 * the id of a registration team is dropped, as results_team_names does. `registrationTeamIds` is
 * every id that is not the host's to name: Supabase's `teams` of the event, plus every team with a
 * live member from the online registration (one moved into a host team after it was named drops
 * that host name, here and in results_team_names). For any other id the host's own row wins over
 * Supabase's copy of it, which is only the last pushed one (a rename may not be pushed yet).
 * @param {Object<string,string>} remote  results_team_names(): teamId → name
 * @param {Array<{id:string,name:string}>} hostRows  this event's host_teams rows
 * @param {Iterable<string>} [registrationTeamIds]
 */
export function mergeTeamNames(remote = {}, hostRows = [], registrationTeamIds = []) {
  const notHost = new Set(registrationTeamIds)
  const names = { ...(remote || {}) }
  for (const row of hostRows || []) {
    if (!row?.id || notHost.has(row.id)) continue
    if (row.name) names[row.id] = row.name
  }
  return names
}

/** Supabase's team_neutral_name(id): „Drużyna” and the first 8 characters of the id, upper case. */
export const neutralTeamName = (teamId) => `Drużyna ${String(teamId).slice(0, 8).toUpperCase()}`
