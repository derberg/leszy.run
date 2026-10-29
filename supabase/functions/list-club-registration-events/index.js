import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { isUuid, loadOrganizerClub } from '../_shared/registration/organizerEvent.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

const PAGE = 1000
const ID_CHUNK = 100

// PostgREST caps a response at 1000 rows: read every page.
async function allRows(build) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) return out
  }
}

// `.in()` puts every id in the URL: query in chunks.
async function byEventIds(ids, build) {
  const out = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) out.push(...await allRows(() => build(ids.slice(i, i + ID_CHUNK))))
  return out
}

// POST { clubId } → { data: [{ eventId, name, state, eventDate, taken, capacity, hasPending }] },
// newest first. Any active member; Plan 1's order for a club-scoped call.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const session = await getSession(req, admin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  try {
    const clubId = body?.clubId
    if (!isUuid(clubId)) return json({ error: 'clubId required' }, 400, req)
    const club = await loadOrganizerClub(admin, clubId, session, { write: false, req })
    if (club instanceof Response) return club

    const events = await allRows(() => admin.from('registration_settings')
      .select('event_id, name, state, event_date').eq('club_id', clubId)
      .order('created_at', { ascending: false }).order('event_id'))
    const ids = events.map((e) => e.event_id)
    const [competitions, pending] = await Promise.all([
      byEventIds(ids, (chunk) => admin.from('competitions').select('event_id, taken, capacity, hidden_at')
        .in('event_id', chunk).order('category_id')),
      byEventIds(ids, (chunk) => admin.from('registration_pending_changes').select('event_id')
        .in('event_id', chunk).order('event_id')),
    ])

    const totals = new Map()
    for (const c of competitions) {
      if (c.hidden_at) continue
      const t = totals.get(c.event_id) ?? { taken: 0, capacity: 0 }
      t.taken += c.taken
      t.capacity += c.capacity
      totals.set(c.event_id, t)
    }
    const pendingIds = new Set(pending.map((p) => p.event_id))

    return json({ data: events.map((e) => ({
      eventId: e.event_id,
      name: e.name,
      state: e.state,
      eventDate: e.event_date,
      taken: totals.get(e.event_id)?.taken ?? 0,
      capacity: totals.get(e.event_id)?.capacity ?? 0,
      hasPending: pendingIds.has(e.event_id),
    })) }, 200, req)
  } catch (err) {
    console.error('list-club-registration-events error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
