import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

import { clubRole, clubRegistrationEnabled, clientIp, logOrganizerAction, ORGANIZER_AGREEMENT_VERSION } from '../_shared/organizer.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const session = await getSession(req, admin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try {
    const { clubId, version } = await req.json()
    if (!clubId || !version) return json({ error: 'clubId, version required' }, 400, req)

    if (!(await clubRegistrationEnabled(admin, clubId))) return json({ error: 'Not found' }, 404, req)
    const role = await clubRole(admin, clubId, session.userId)
    if (role !== 'owner') return json({ error: 'Umowę przyjmuje właściciel klubu.' }, 403, req)
    if (version !== ORGANIZER_AGREEMENT_VERSION) {
      return json({ error: 'Umowa została zaktualizowana. Odśwież stronę.', version: ORGANIZER_AGREEMENT_VERSION }, 409, req)
    }

    const { data: club } = await admin.from('clubs').select('name').eq('id', clubId).single()
    const { data: row, error } = await admin.from('organizer_agreements').insert({
      club_id: clubId, club_name: club.name, version, accepted_by: session.userId,
      ip: clientIp(req), user_agent: req.headers.get('user-agent') || null,
    }).select('id, version, accepted_at').single()
    if (error) throw error

    await logOrganizerAction(admin, req, {
      actorId: session.userId, clubId, action: 'agreement_accepted', target: row.id, payload: { version },
    })
    return json({ data: { accepted: true, version: row.version, acceptedAt: row.accepted_at } }, 200, req)
  } catch (err) {
    console.error('accept-organizer-agreement error:', err)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
