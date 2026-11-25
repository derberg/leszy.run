import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { allRows } from '../_shared/registration/allRows.js'
import {
  LISTED_ORDER_STATUSES, LISTED_REGISTRATION_STATUSES, shapeMyRegistrations,
} from '../_shared/registration/myRegistrations.js'
import { acceptedRefundTotals } from '../_shared/registration/refundedTotals.js'
import { transferViews } from '../_shared/registration/transfers.js'
import { clubsWithAgreement } from '../_shared/organizer.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// Ids per `.in()` filter, so a long list never makes an over-long URL.
const CHUNK = 100
const chunks = (ids) => {
  const out = []
  for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK))
  return out
}

const REG_COLUMNS = 'id, event_id, category_id, order_id, status, first_name, last_name, profile_id, email, guardian_profile_id, team_id, birth_date, created_at'

// POST {} → 200 { data: [{ eventId, slug, eventName, eventDate, firstStartTime,
//   orders: [{ id, status, total, refunded, cancelled, expiresAt, paidAt, createdAt }],
//   people: [{ id, firstName, lastName, competition, status, mine,
//     surcharge: { orderId, toCompetition, grosze, expiresAt } | null,
//     actions: { change, edit },
//     transfer: { allowed, until, pending: { transferId, toEmail, createdAt, expiresAt } | null, refundPending } | null }] }] }
//   (actions: the runner's own „Zmień konkurencję” / „Popraw dane”, selfService.js; my-entry-action
//   decides. transfer: „Przekaż pakiet”, the same block and rule as my-event-registrations
//   (transferViews): allowed only on the session's own confirmed adult entry or a team's as captain,
//   never on an entry it registered for somebody else; null for an event with transfers off.)
// „Moje zapisy”: every published (or closed) registration event where the session bought an order
// (pending or paid) or is on a live entry (confirmed or awaiting payment) as the runner, as the
// person who registered it, or as a child's guardian. The people of the session's own orders are
// listed too. An entry an organizer transfer moved to someone else is never shown to the old buyer
// (ruling N-1), the same rule as my-event-registrations' M-4. Upcoming events first, soonest first,
// then past ones, latest first. 401 without a session.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const session = await getSession(req, admin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try { await req.json() } catch { /* the body carries nothing */ }

  try {
    const me = session.userId
    const orders = await allRows(() => admin.from('orders')
      .select('id, event_id, buyer_profile_id, status, total, expires_at, paid_at, created_at, kind, surcharge_registration_id, surcharge_to_category_id')
      .eq('buyer_profile_id', me).in('status', LISTED_ORDER_STATUSES).order('id'))

    const own = await allRows(() => admin.from('registrations').select(REG_COLUMNS)
      .in('status', LISTED_REGISTRATION_STATUSES)
      .or(`profile_id.eq.${me},registered_by_profile_id.eq.${me},guardian_profile_id.eq.${me}`)
      .order('id'))
    // A competition change's surcharge owns no registration (shapeMyRegistrations shows an open one
    // on its entry): only registration orders hold entries and refunds of their own here.
    const entryOrders = orders.filter((o) => o.kind !== 'surcharge')
    const inOrders = []
    for (const ids of chunks(entryOrders.map((o) => o.id))) {
      inOrders.push(...await allRows(() => admin.from('registrations').select(REG_COLUMNS)
        .in('status', LISTED_REGISTRATION_STATUSES).in('order_id', ids).order('id')))
    }
    const candidates = [...new Map([...own, ...inOrders].map((r) => [r.id, r])).values()]
    // Before the N-1 filter: a package the organizer moved on still holds its order's place.
    const liveOrderIds = new Set(inOrders.map((r) => r.order_id))
    const refunded = await acceptedRefundTotals(admin, orders.map((o) => o.id))
    // A paid surcharge's refund is money given back of the entry: counted on the entry's own order.
    const orderOfReg = new Map(candidates.map((r) => [r.id, r.order_id]))
    for (const o of orders.filter((x) => x.kind === 'surcharge')) {
      const into = orderOfReg.get(o.surcharge_registration_id)
      const back = refunded.get(o.id) ?? 0
      if (into && back) refunded.set(into, (refunded.get(into) ?? 0) + back)
    }

    const others = candidates.filter((r) => r.profile_id !== me).map((r) => r.id)
    const byOrganizer = new Set()
    for (const ids of chunks(others)) {
      const moved = await allRows(() => admin.from('transfers').select('id, new_registration_id')
        .eq('kind', 'organizer').in('new_registration_id', ids).order('id'))
      for (const t of moved) byOrganizer.add(t.new_registration_id)
    }
    const registrations = candidates.filter((r) => !byOrganizer.has(r.id))

    const eventIds = [...new Set([...orders.map((o) => o.event_id), ...registrations.map((r) => r.event_id)])]
    const settings = []
    for (const ids of chunks(eventIds)) {
      settings.push(...await allRows(() => admin.from('registration_settings')
        .select('event_id, slug, name, state, event_date, first_start_time, closes_at, runner_competition_change, runner_data_edit, club_id, transfer_enabled, transfer_until')
        .in('event_id', ids).order('event_id')))
    }
    // Which team entries are their team's captain: only a captain edits (selfService.js).
    const teamIds = [...new Set(registrations.map((r) => r.team_id).filter(Boolean))]
    const captains = new Set()
    for (const ids of chunks(teamIds)) {
      const teams = await allRows(() => admin.from('teams').select('id, captain_registration_id').in('id', ids).order('id'))
      for (const t of teams) if (t.captain_registration_id) captains.add(t.captain_registration_id)
    }
    // Every pending surcharge of a listed entry, whoever pays it: „Zmień konkurencję” waits for it.
    const openSurcharges = []
    for (const ids of chunks(registrations.map((r) => r.id))) {
      openSurcharges.push(...await allRows(() => admin.from('orders')
        .select('id, kind, status, total, expires_at, surcharge_registration_id, surcharge_to_category_id')
        .eq('kind', 'surcharge').eq('status', 'pending').in('surcharge_registration_id', ids).order('id')))
    }
    // A club with registration switched off: no self-service (my-entry-action answers 404).
    const enabledClubs = new Set()
    for (const ids of chunks([...new Set(settings.map((s) => s.club_id).filter(Boolean))])) {
      const clubs = await allRows(() => admin.from('clubs').select('id, registration_enabled').in('id', ids).order('id'))
      for (const c of clubs) if (c.registration_enabled === true) enabledClubs.add(c.id)
    }
    // „Zmień konkurencję” needs the club to have the organizer agreement, any version (L-2, §13 ust. 6).
    const agreementClubs = await clubsWithAgreement(admin, [...enabledClubs])
    const categoryIds = [...new Set([
      ...registrations.map((r) => r.category_id),
      ...orders.map((o) => o.surcharge_to_category_id),
    ].filter(Boolean))]
    const competitions = []
    for (const ids of chunks(categoryIds)) {
      competitions.push(...await allRows(() => admin.from('competitions')
        .select('category_id, name').in('category_id', ids).order('category_id')))
    }

    // „Przekaż pakiet”: my-event-registrations' block, for every published event with an entry of
    // the session's own, transfers on or off, so a still-open invite reads as on RA5 even after the
    // club switched transfers off; transferAllowed (inside transferViews) still decides `allowed`.
    const transfers = new Map()
    const views = await Promise.all(settings
      .filter((s) => s.state !== 'draft')
      .map((s) => registrations.filter((r) => r.event_id === s.event_id))
      .filter((regs) => regs.some((r) => r.profile_id === me))
      .map((regs) => transferViews(admin, regs, settings.find((s) => s.event_id === regs[0].event_id), me)))
    for (const map of views) for (const [id, view] of map) transfers.set(id, view)

    return json({ data: shapeMyRegistrations({ userId: me, email: session.email, settings, orders, registrations, competitions, refunded, liveOrderIds, captains, openSurcharges, enabledClubs, agreementClubs, transfers }) }, 200, req)
  } catch (err) {
    console.error('my-registrations error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
