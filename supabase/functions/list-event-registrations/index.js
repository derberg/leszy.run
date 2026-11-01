import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { loadEntries } from '../_shared/registration/organizerEntries.js'

// Runner personal data: never kept by a browser or a proxy cache.
function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

const READERS = ['owner', 'admin']

// POST { eventId } → 200 { data: rows, counts, teams, competitions, event }, every registration of
// the event in sign-up order. The rows are loadEntries' (organizerEntries.js), which documents every
// field: Plans 2–5's (paymentStatus 'paid' | 'free' | 'awaiting' | null, role, consentState,
// guardianName, guardianRemoved, registeredBy, team) and the panel's (the split person fields for
// „Edytuj dane”, email, bib, orderId, price, lines, paidAmount, refunded, refundUnconfirmed,
// statusKey, autoRefundReason, partnerId, partnerName, voucherCode).
//   counts        { paid, awaiting, free, placesLeft, teamPlacesLeft, awaitingConsent }, per person
//                 (D5-32); placesLeft and teamPlacesLeft are people's and teams' places apart
//   teams         the teams not released: { id, name, size, consentAccepted, fee, captainId,
//                 competition, captain, status, paymentStatus, expiresAt }
//   competitions  the visible ones, in the event's order: [{ id, name, capacity, taken, kind }]
//   event         { name, slug, eventDate, closesAt, state }
//   partners      the event's partners: [{ id, name, count }], count = live entries attributed
// A child's guardian address is not returned (the CSV export has it).
//
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

    const { rows, counts, teams, competitions, event, partners } = await loadEntries(admin, loaded.settings)
    return json({ data: rows, counts, teams, competitions, event, partners }, 200, req)
  } catch (err) {
    console.error('list-event-registrations error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
