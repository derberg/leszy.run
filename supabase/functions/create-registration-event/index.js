import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { isUuid, loadOrganizerClub } from '../_shared/registration/organizerEvent.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// POST { clubId, name } → 201 { data: { eventId } }. Owner or admin of an
// enabled club with the current organizer agreement. The draft events row and
// its registration_settings row are written together by one RPC.
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
    const { clubId, name } = body ?? {}
    if (!isUuid(clubId)) return json({ error: 'clubId required' }, 400, req)

    const club = await loadOrganizerClub(admin, clubId, session, { write: true, req })
    if (club instanceof Response) return club

    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed || trimmed.length > 120) {
      const message = trimmed ? 'Najwyżej 120 znaków.' : 'Podaj nazwę wydarzenia.'
      return json({ error: message, fields: { name: message } }, 422, req)
    }

    const { data: eventId, error } = await admin.rpc('create_registration_event', {
      p_club_id: clubId, p_name: trimmed, p_actor: session.userId,
    })
    if (error) throw error

    await logOrganizerAction(admin, req, {
      actorId: session.userId, clubId, eventId, action: 'event_created', target: eventId,
    })
    return json({ data: { eventId } }, 201, req)
  } catch (err) {
    console.error('create-registration-event error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
