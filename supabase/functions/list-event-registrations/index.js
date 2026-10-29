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

// 'paid' | 'awaiting' | 'free' for a live registration, null otherwise. A 0 zł entry
// inside a paid group order (a free kids race beside a parent's paid one) is 'free':
// nothing was paid for that person. start_list() applies the same rule.
function paymentStatusOf(reg, order) {
  if (reg.status === 'pending_payment') return 'awaiting'
  if (reg.status !== 'confirmed') return null
  return order && order.total > 0 && reg.price > 0 ? 'paid' : 'free'
}

// A child's row always has a guardian: guardian_profile_id until the guardian deletes the account
// (the contact purge keeps it), guardian_removed_at after. An added adult was registered by an
// account that is not theirs, or still waits for their acceptance or was signed in the office:
// delete-my-account nulls registered_by when the payer deletes their account, and only an added
// adult is ever 'awaiting' or 'office'. Plan 2 and 3 rows (no registered_by) registered themselves.
function roleOf(r) {
  if (r.guardian_profile_id || r.guardian_removed_at) return 'minor'
  if (r.registered_by_profile_id && r.profile_id !== r.registered_by_profile_id) return 'adult'
  if (r.consent_state === 'awaiting' || r.consent_state === 'office') return 'adult'
  return 'self'
}

const LIVE = new Set(['confirmed', 'pending_payment'])
const ID_CHUNK = 100
// An entry whose person deleted the account reads „Usunięte konto Usunięte konto”: not a name.
const DELETED = 'Usunięte konto'
const fullName = (r) => (r.first_name === DELETED ? null : `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim())

// Who registered each added adult and child, by the rule consentRequests.js names the buyer
// in the consent e-mail; everything but the display name comes from rows already read.
async function registeredByNames(admin, regs, orderOf) {
  const byProfile = new Map()
  // Lowest precedence first; a later set overrides. Within a list the latest row wins.
  const latestFirst = regs.filter((r) => LIVE.has(r.status)).reverse()
  const ids = [...new Set(regs.filter((r) => roleOf(r) !== 'self').map((r) => r.registered_by_profile_id).filter(Boolean))]
  // One request per ID_CHUNK ids: every id travels in the GET URL, and a large event has hundreds of payers.
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const profiles = await allRows(() => admin.from('profiles').select('id, display_name').in('id', chunk).is('deleted_at', null).order('id'))
    // A deleted account's display name („Uczestnik anonimowy”) names nobody: left out above.
    for (const p of profiles) if (p.display_name?.trim()) byProfile.set(p.id, p.display_name.trim())
  }
  const setFirst = (rows, key, name) => {
    const seen = new Set()
    for (const x of rows) {
      const n = name(x)
      if (!x[key] || !n || seen.has(x[key])) continue
      seen.add(x[key])
      byProfile.set(x[key], n)
    }
  }
  setFirst(latestFirst.filter((r) => r.guardian_profile_id), 'guardian_profile_id', (r) => r.guardian_name?.trim())
  setFirst(latestFirst.filter((r) => r.profile_id && roleOf(r) === 'self'), 'profile_id', fullName)
  return (r) => orderOf.get(r.order_id)?.buyer_name?.trim() || byProfile.get(r.registered_by_profile_id) || null
}

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
// status, createdAt, paymentStatus, expiresAt, role, consentState, guardianName,
// guardianRemoved, registeredBy }], counts: { paid, awaiting, free, placesLeft,
// awaitingConsent } }, every registration of the event in sign-up order. paymentStatus: 'paid' (confirmed
// through an order with money in it), 'free' (confirmed with nothing to pay),
// 'awaiting' (pending_payment; expiresAt is its order's payment deadline), or null
// for a registration that is no longer live (expired, cancelled, transferred), which
// counts for nothing (D3-6: the counts sit beside data, whose shape is unchanged).
//
// Consents (Plan 4, task 6):
//   role            'self' (registered themself), 'adult' (added by somebody else, accepts by the
//                   consent link) or 'minor' (a child, accepted by the guardian)
//   consentState    'accepted' | 'awaiting' | 'office' (registrations.consent_state)
//   guardianName    a child's guardian, null otherwise and once removed
//   guardianRemoved the guardian deleted their account (D4-25). Read from guardian_removed_at,
//                   never from null guardian fields: the 30-day contact purge nulls those for
//                   every child of a past event.
//   registeredBy    who registered an added adult or a child: the name the buyer typed for the
//                   order, else the buyer's own entry in the event, else the guardian name their
//                   children carry, else the account's display name; null for 'self'
//   counts.awaitingConsent  confirmed entries still waiting for the person's acceptance
// No address, phone or birth date is returned.
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
    const eventId = loaded.settings.event_id

    const [regs, comps, orders] = await Promise.all([
      allRows(() => admin.from('registrations')
        .select('id, category_id, order_id, first_name, last_name, age_group_label, status, created_at, price, ' +
          'profile_id, registered_by_profile_id, consent_state, guardian_profile_id, guardian_name, guardian_removed_at')
        .eq('event_id', eventId).order('created_at').order('id')),
      allRows(() => admin.from('competitions').select('category_id, name, capacity, taken, hidden_at').eq('event_id', eventId).order('category_id')),
      allRows(() => admin.from('orders').select('id, total, expires_at, buyer_name').eq('event_id', eventId).order('id')),
    ])
    const nameOf = new Map(comps.map((c) => [c.category_id, c.name]))
    const orderOf = new Map(orders.map((o) => [o.id, o]))

    // placesLeft: capacity minus confirmed entries over the visible competitions. Entries
    // awaiting payment hold no place (P3-R15), so they do not lower it.
    const placesLeft = comps.filter((c) => !c.hidden_at)
      .reduce((n, c) => n + Math.max(0, (c.capacity ?? 0) - (c.taken ?? 0)), 0)
    const counts = { paid: 0, awaiting: 0, free: 0, placesLeft, awaitingConsent: 0 }
    const registeredBy = await registeredByNames(admin, regs, orderOf)
    const data = regs.map((r) => {
      const order = r.order_id ? orderOf.get(r.order_id) : null
      const paymentStatus = paymentStatusOf(r, order)
      if (paymentStatus) counts[paymentStatus] += 1
      const role = roleOf(r)
      const guardianRemoved = role === 'minor' && r.guardian_removed_at != null
      if (r.status === 'confirmed' && r.consent_state === 'awaiting') counts.awaitingConsent += 1
      return {
        id: r.id,
        // A deleted account's entry carries the pair „Usunięte konto” „Usunięte konto”: shown once.
        name: r.first_name === DELETED ? DELETED : `${r.first_name} ${r.last_name}`,
        competition: nameOf.get(r.category_id) ?? null,
        ageGroupLabel: r.age_group_label,
        status: r.status,
        createdAt: r.created_at,
        paymentStatus,
        expiresAt: paymentStatus === 'awaiting' ? (order?.expires_at ?? null) : null,
        role,
        consentState: r.consent_state,
        guardianName: role === 'minor' && !guardianRemoved ? (r.guardian_name ?? null) : null,
        guardianRemoved,
        registeredBy: role === 'self' ? null : registeredBy(r),
      }
    })
    return json({ data, counts }, 200, req)
  } catch (err) {
    console.error('list-event-registrations error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
