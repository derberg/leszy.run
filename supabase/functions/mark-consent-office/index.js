// POST { registrationId } — „Regulamin podpisany w biurze” (Plan 4): the organizer records that
// an added adult signed the event's terms on paper. Owner/admin only, through
// loadOrganizerEvent(…, { write: true }) on the registration's event: an outsider or a disabled
// club gets 404, a plain member 403 (P2-R9). mark_consent_office sets consent_state 'office',
// records the event consents as 'office' acceptances by the organizer and spends the link.
//
// → 200 { data: { consentState: 'office' } }; 401 no session; 404; 403 member;
//   409 not_awaiting (already accepted or signed, or the entry is not confirmed).
// Logged to organizer_actions ('consent_office').
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { isUuid, loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { json, NOT_FOUND } from '../_shared/registration/registrationRequest.js'

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  try {
    const session = await getSession(req, admin)
    if (!session) return json({ error: 'Authorization required' }, 401, req)

    const registrationId = body?.registrationId
    if (!isUuid(registrationId)) return json(NOT_FOUND, 404, req)
    const { data: reg, error } = await admin.from('registrations').select('id, event_id').eq('id', registrationId).maybeSingle()
    if (error) throw error
    if (!reg) return json(NOT_FOUND, 404, req)

    const access = await loadOrganizerEvent(admin, reg.event_id, session, { write: true, req })
    if (access instanceof Response) return access

    const { data: done, error: rpcErr } = await admin.rpc('mark_consent_office', { p_registration_id: reg.id, p_actor: session.userId })
    if (rpcErr) throw rpcErr
    if (done !== true) {
      return json({ error: 'To zgłoszenie nie czeka na akceptację regulaminu.', code: 'not_awaiting' }, 409, req)
    }
    await logOrganizerAction(admin, req, {
      actorId: session.userId, clubId: access.settings.club_id, eventId: reg.event_id, action: 'consent_office', target: reg.id,
    })
    return json({ data: { consentState: 'office' } }, 200, req)
  } catch (err) {
    console.error('mark-consent-office error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
