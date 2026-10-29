// Authorization for the organizer functions. Plain ESM (Response is a web
// standard), shared by every registration function that acts for a club.
//
// Club-scoped (create, list): Plan 1's order. A non-member gets 403 whether the
// club is enabled or not, then a disabled club 404, then a member's write 403,
// then a missing agreement 409.
// Event-scoped: the club comes from registration_settings.club_id, never from
// the client. An outsider and a disabled club get 404 (the event is not
// theirs to know about); an active member's write gets 403.

import { clubRole, clubRegistrationEnabled, ORGANIZER_AGREEMENT_VERSION } from '../organizer.js'
import { getCorsHeaders } from '../cors.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v)

export const AGREEMENT_REQUIRED = { error: 'Brak akceptacji umowy organizatora.', code: 'agreement_required' }

const WRITERS = ['owner', 'admin']

function respond(req, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...(req ? getCorsHeaders(req) : {}), 'Content-Type': 'application/json' },
  })
}

export async function clubHasAgreement(admin, clubId) {
  const { data, error } = await admin.from('organizer_agreements')
    .select('id').eq('club_id', clubId).eq('version', ORGANIZER_AGREEMENT_VERSION).limit(1)
  if (error) throw error
  return (data?.length ?? 0) > 0
}

/** → { role } | Response (403 non-member, 404 disabled, 403 member write, 409 agreement). */
export async function loadOrganizerClub(admin, clubId, session, { write = false, req = null } = {}) {
  const role = isUuid(clubId) ? await clubRole(admin, clubId, session.userId) : null
  if (!role) return respond(req, 403, { error: 'Brak uprawnień.' })
  if (!(await clubRegistrationEnabled(admin, clubId))) return respond(req, 404, { error: 'Not found' })
  if (write && !WRITERS.includes(role)) return respond(req, 403, { error: 'Brak uprawnień.' })
  if (!(await clubHasAgreement(admin, clubId))) return respond(req, 409, AGREEMENT_REQUIRED)
  return { role }
}

/** → { settings, role } | Response (404 outsider or disabled club, 403 member write). */
export async function loadOrganizerEvent(admin, eventId, session, { write = false, req = null } = {}) {
  const notFound = () => respond(req, 404, { error: 'Not found' })
  if (!isUuid(eventId)) return notFound()
  const { data: settings, error } = await admin.from('registration_settings')
    .select('*').eq('event_id', eventId).maybeSingle()
  if (error) throw error
  if (!settings) return notFound()
  const role = await clubRole(admin, settings.club_id, session.userId)
  if (!role) return notFound()
  if (!(await clubRegistrationEnabled(admin, settings.club_id))) return notFound()
  if (write && !WRITERS.includes(role)) return respond(req, 403, { error: 'Brak uprawnień.' })
  return { settings, role }
}
