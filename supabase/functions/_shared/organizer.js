// Shared by the organizer-side registration functions.
import { clientIp } from './clientIp.js'

// Bump together with public/src/legal/organizerAgreement.js (public/tests/unit/agreementVersion.test.js checks it).
export const ORGANIZER_AGREEMENT_VERSION = '2026-11-v2'

/** The caller's active role in the club ('owner' | 'admin' | 'member'), or null. */
export async function clubRole(admin, clubId, userId) {
  const { data } = await admin.from('club_members')
    .select('role').eq('club_id', clubId).eq('user_id', userId).eq('status', 'active').maybeSingle()
  return data?.role ?? null
}

export async function clubRegistrationEnabled(admin, clubId) {
  const { data } = await admin.from('clubs').select('registration_enabled').eq('id', clubId).maybeSingle()
  return data?.registration_enabled === true
}

// The one validated parser (clientIp.js); re-exported for the functions that import it from here.
export { clientIp }

export async function logOrganizerAction(admin, req, { actorId, clubId, eventId = null, action, target = null, payload = null }) {
  const { error } = await admin.from('organizer_actions').insert({
    actor_id: actorId, club_id: clubId, event_id: eventId, action, target, payload,
    ip: clientIp(req), user_agent: req.headers.get('user-agent') || null,
  })
  if (error) console.error('organizer_actions insert failed:', error.message)
}
