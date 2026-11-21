// Team names for the admin participants table, read from Supabase on request and never
// stored: a team name is personal data the host does not hold (see db/schema.js,
// participants.teamId). `results_team_names` returns only live teams of a published event,
// and the 30-day purge has already replaced a past team's name there, so the host shows
// exactly what the public results show. Without Supabase (or on an error) it returns {},
// and the table labels a team by its members' surnames instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function fetchTeamNames(supabase, eventId) {
  if (!supabase || !UUID_RE.test(String(eventId || ''))) return {}
  try {
    const { data, error } = await supabase.rpc('results_team_names', { p_event_id: eventId })
    if (error) {
      console.warn(`[teamNames] results_team_names failed: ${error.message}`)
      return {}
    }
    const names = {}
    for (const row of data || []) {
      if (row?.team_id && row.name) names[row.team_id] = row.name
    }
    return names
  } catch (err) {
    console.warn(`[teamNames] results_team_names failed: ${err.message}`)
    return {}
  }
}

// Ids of the event's registration teams (Supabase `teams`, released ones too), so the host never
// lets its own host_teams row stand in for a registration team's name. [] without Supabase.
export async function fetchRegistrationTeamIds(supabase, eventId) {
  if (!supabase || !UUID_RE.test(String(eventId || ''))) return []
  try {
    const { data, error } = await supabase.from('teams').select('id').eq('event_id', eventId)
    if (error) {
      console.warn(`[teamNames] teams failed: ${error.message}`)
      return []
    }
    return (data || []).map(r => r.id).filter(Boolean)
  } catch (err) {
    console.warn(`[teamNames] teams failed: ${err.message}`)
    return []
  }
}
