// POST { registrationId } — a new consent link for an added adult (Plan 4, ruling 5).
// Allowed for the person who registered them (registered_by_profile_id, RA5) or an owner/admin
// of the event's club (loadOrganizerEvent on the registration's event: an outsider or a disabled
// club gets 404, and so does a plain member, P2-R20). The token is rotated, so the previous link
// stops working, and the e-mail goes out as „Przypomnienie: …”. consent-remind:<id> allows 3 per
// registration per 24 h, whoever asks; the automatic reminder does not count (D4-24). Every
// refusal that can be decided first (not authorized, not awaiting, the link used or expired) is
// answered before a slot is claimed, and a link that went meanwhile (409) gives its slot back
// (release_throttle_slot). A refused e-mail (502) keeps it: every retry rotates the token and
// calls the sender, so it stays under the 3 per 24 h.
//
// → 200 { data: { status: 'sent' } }
//   401 no session; 404 unknown, not yours, or a member; 409 not_awaiting (accepted, signed in
//   the office, cancelled, or the link expired); 429 „Przypomnienie zostało już wysłane. Spróbuj
//   jutro.”; 502 the e-mail was not accepted (the old link is dead all the same).
// An organizer's reminder is logged (organizer_actions 'consent_reminded').
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { checkAndIncrement } from '../_shared/throttle.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { isUuid, loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { json, NOT_FOUND } from '../_shared/registration/registrationRequest.js'
import { rotateAndSend } from '../_shared/registration/consentRequests.js'

const REMIND_LIMIT = 3
const DAY = 24 * 3600
const NOT_AWAITING = { error: 'To zgłoszenie nie czeka na akceptację regulaminu.', code: 'not_awaiting' }

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
    const { data: reg, error } = await admin.from('registrations')
      .select('id, event_id, registered_by_profile_id, status, consent_state, email').eq('id', registrationId).maybeSingle()
    if (error) throw error
    if (!reg) return json(NOT_FOUND, 404, req)

    let organizer = null
    if (reg.registered_by_profile_id !== session.userId) {
      const access = await loadOrganizerEvent(admin, reg.event_id, session, { req })
      if (access instanceof Response) return access
      if (!['owner', 'admin'].includes(access.role)) return json(NOT_FOUND, 404, req)
      organizer = access
    }

    if (reg.status !== 'confirmed' || reg.consent_state !== 'awaiting' || !reg.email) return json(NOT_AWAITING, 409, req)
    // A spent or expired link cannot be rotated (rotate_consent_request); no request at all is the
    // crash window, which rotateAndSend issues.
    const { data: request, error: qErr } = await admin.from('consent_requests')
      .select('used_at, expires_at').eq('registration_id', reg.id).maybeSingle()
    if (qErr) throw qErr
    if (request && (request.used_at || Date.parse(request.expires_at) <= Date.now())) return json(NOT_AWAITING, 409, req)

    // Fail closed: this sends e-mail to a third party.
    const slot = `consent-remind:${reg.id}`
    const throttle = await checkAndIncrement(admin, slot, REMIND_LIMIT, { windowSeconds: DAY })
    if (!throttle.allowed) {
      return json({ error: 'Przypomnienie zostało już wysłane. Spróbuj jutro.', code: 'throttled' }, 429, req,
        { 'retry-after': String(throttle.retryAfterSec) })
    }

    const outcome = await rotateAndSend(admin, reg.id, { reminder: true })
    if (outcome === 'not_awaiting') {
      const { error: rErr } = await admin.rpc('release_throttle_slot', { p_key: slot })
      if (rErr) console.error(`remind-consent ${reg.id}: slot not released:`, rErr.message)
    }
    if (outcome === 'not_awaiting') return json(NOT_AWAITING, 409, req)
    if (organizer) {
      await logOrganizerAction(admin, req, {
        actorId: session.userId, clubId: organizer.settings.club_id, eventId: reg.event_id,
        action: 'consent_reminded', target: reg.id, payload: { sent: outcome === 'sent' },
      })
    }
    if (outcome === 'failed') {
      return json({ error: 'Nie udało się wysłać przypomnienia. Spróbuj ponownie później.', code: 'email_failed' }, 502, req)
    }
    return json({ data: { status: 'sent' } }, 200, req)
  } catch (err) {
    console.error('remind-consent error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
