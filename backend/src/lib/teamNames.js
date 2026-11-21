// Team names for the admin participants table, read from Supabase on request and never
// stored: a team name is personal data the host does not hold (see db/schema.js,
// participants.teamId). `results_team_names` returns only live teams of a published event,
// and the 30-day purge has already replaced a past team's name there, so the host shows
// exactly what the public results show. Without Supabase (or on an error) it returns {},
// and the table labels a team by its members' surnames instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Each Supabase read gives up after this long and falls back as on an error: on a race-day
// hotspot a request can hang, and the participants table and a team-name save must not hang
// with it. The query is aborted (supabase-js abortSignal) and, should the abort not settle it,
// the timer below still answers.
export const SUPABASE_TIMEOUT_MS = 3000

function bounded(builder, ms) {
  const query = typeof builder?.abortSignal === 'function' ? builder.abortSignal(AbortSignal.timeout(ms)) : builder
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms) })
  return Promise.race([Promise.resolve(query), timeout]).finally(() => clearTimeout(timer))
}

export async function fetchTeamNames(supabase, eventId, { timeoutMs = SUPABASE_TIMEOUT_MS } = {}) {
  if (!supabase || !UUID_RE.test(String(eventId || ''))) return {}
  try {
    const { data, error } = await bounded(supabase.rpc('results_team_names', { p_event_id: eventId }), timeoutMs)
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
export async function fetchRegistrationTeamIds(supabase, eventId, { timeoutMs = SUPABASE_TIMEOUT_MS } = {}) {
  if (!supabase || !UUID_RE.test(String(eventId || ''))) return []
  try {
    const { data, error } = await bounded(supabase.from('teams').select('id').eq('event_id', eventId), timeoutMs)
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
