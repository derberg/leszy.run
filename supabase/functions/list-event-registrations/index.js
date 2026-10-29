import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

const PAGE = 1000
const READERS = ['owner', 'admin']

// PostgREST caps a response at 1000 rows, so every list read pages.
async function allRows(makeQuery) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1)
    if (error) throw error
    out.push(...data)
    if (data.length < PAGE) return out
  }
}

// POST { eventId } → 200 { data: [{ id, name, competition, ageGroupLabel,
// status, createdAt }] }, every registration of the event in sign-up order.
// The owner and admins of the owning club (registration_settings.club_id)
// only: runner personal data is not for every member (ruling P2-R20). A
// member, an outsider or a disabled club gets 404 (event-scoped, P2-R9), no
// session 401.
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
    const loaded = await loadOrganizerEvent(admin, body?.eventId, session, { write: false, req })
    if (loaded instanceof Response) return loaded
    if (!READERS.includes(loaded.role)) return json({ error: 'Not found' }, 404, req)
    const eventId = loaded.settings.event_id

    const [regs, comps] = await Promise.all([
      allRows(() => admin.from('registrations')
        .select('id, category_id, first_name, last_name, age_group_label, status, created_at')
        .eq('event_id', eventId).order('created_at').order('id')),
      allRows(() => admin.from('competitions').select('category_id, name').eq('event_id', eventId).order('category_id')),
    ])
    const nameOf = new Map(comps.map((c) => [c.category_id, c.name]))

    return json({
      data: regs.map((r) => ({
        id: r.id,
        name: `${r.first_name} ${r.last_name}`,
        competition: nameOf.get(r.category_id) ?? null,
        ageGroupLabel: r.age_group_label,
        status: r.status,
        createdAt: r.created_at,
      })),
    }, 200, req)
  } catch (err) {
    console.error('list-event-registrations error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
