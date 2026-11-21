// Moving a runner to another team on the host ("Drużyna" in the participants table), for the
// last-minute request at the start. It changes the timing copy only: participants.team_id /
// team_leg, which the push sends to Supabase's participants row, where the public results read
// it. The registration (registrations.team_id: start list, the organizer's Zgłoszenia, the fee)
// is not touched. Caveat: until registration closes, a captain's or organizer's squad edit
// (team_squad_edit) fires the Supabase trigger registration_team_to_participant, which writes
// the registration's team back onto every member of that team, a runner moved here included,
// and configSync then pulls it. A host move is meant for race day, after the close.
//
// Before the gun only, like "Nie startuje": the detector takes the teams at race start, so a
// change after it would split the host's standings from what the detector counts.
// A relay team has at most 10 people (registration), so 100 legs is far above any real one
// and keeps the value inside the integer column.
const MAX_LEG = 100
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Why a team change is refused, or null when it may go ahead.
 * @param {{ teamId?: string|null, teamLeg?: number|null }} updates the PATCH's team fields
 * @param {number} liveResults the runner's results in race runs that were not cancelled
 * @returns {{ status: number, error: string }|null}
 */
export function teamEditRefusal(updates, liveResults) {
  const { teamId, teamLeg } = updates
  if (teamId === undefined && teamLeg === undefined) return null
  if (teamId != null && !UUID_RE.test(String(teamId))) return { status: 400, error: 'teamId must be a UUID or null' }
  if (teamLeg != null && !(Number.isInteger(teamLeg) && teamLeg >= 1 && teamLeg <= MAX_LEG)) return { status: 400, error: `teamLeg must be an integer 1..${MAX_LEG} or null` }
  if (liveResults > 0) return { status: 409, error: 'Bieg już wystartował. Drużynę zmienia się przed startem.' }
  return null
}
