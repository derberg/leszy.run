// „Moje zapisy” (/profil/zapisy): every registration event the session is part of, as the buyer of
// an order or as a person on an entry (its own, one it registered, a child it is guardian of).
// Plain ESM: the edge function `my-registrations` reads the rows, this shapes them.
import { warsawToday } from './dates.js'
import { pendingSurcharge } from './entries.js'
import { selfServiceActions } from './selfService.js'

/** Entry statuses listed: live ones only. */
export const LISTED_REGISTRATION_STATUSES = Object.freeze(['confirmed', 'pending_payment'])
/** Order statuses listed: an expired or cancelled order is no longer the buyer's business. */
export const LISTED_ORDER_STATUSES = Object.freeze(['pending', 'paid'])

const byCreated = (a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.id).localeCompare(String(b.id))

/**
 * Upcoming events first, soonest first (an event with no date last among them), then past events,
 * most recent first. `today` is a Warsaw YYYY-MM-DD; race day itself counts as upcoming.
 */
export function compareEvents(a, b, today) {
  const pastA = a.eventDate != null && a.eventDate < today
  const pastB = b.eventDate != null && b.eventDate < today
  if (pastA !== pastB) return pastA ? 1 : -1
  if (a.eventDate !== b.eventDate) {
    if (a.eventDate == null) return 1
    if (b.eventDate == null) return -1
    return pastA ? b.eventDate.localeCompare(a.eventDate) : a.eventDate.localeCompare(b.eventDate)
  }
  return String(a.eventName ?? '').localeCompare(String(b.eventName ?? ''), 'pl') || String(a.eventId).localeCompare(String(b.eventId))
}

/**
 * Shapes the rows into the answer's `data`.
 * @param {object} p
 * @param {string} p.userId the session's profile id
 * @param {object[]} p.settings registration_settings rows: event_id, slug, name, state, event_date, first_start_time
 * @param {object[]} p.orders orders rows: id, event_id, buyer_profile_id, status, total, expires_at, paid_at, created_at,
 *   kind, surcharge_registration_id, surcharge_to_category_id. A competition change's surcharge
 *   (kind 'surcharge') owns no registration, so it is never an order of its own here (a paid one
 *   would read as an order whose entries all went): an open one the session pays is the entry's
 *   `surcharge` ({ orderId, toCompetition, grosze, expiresAt }, else null), so RA5 can link to it.
 * @param {object[]} p.registrations registrations rows: id, event_id, category_id, status, first_name, last_name, profile_id, created_at
 * @param {object[]} p.competitions competitions rows: category_id, name
 * @param {Map<string, number>} [p.refunded] order id → grosze dpay has paid back (accepted refunds)
 * @param {Set<string>} [p.liveOrderIds] orders that still hold a live entry; a paid order outside it
 *   had every entry cancelled (`cancelled: true`). Omitted, no order is marked.
 * @param {string|null} [p.email] the session's address (an adult entry at it is the session's to change)
 * @param {Set<string>} [p.captains] registration ids that captain their team
 * @param {object[]} [p.openSurcharges] pending surcharge orders of the listed entries, whoever pays them
 *   (kind, status, expires_at, surcharge_registration_id): any of them hides „Zmień konkurencję”
 * @param {Set<string>} [p.enabledClubs] club ids with registration_enabled; settings rows need club_id
 * @param {Date} [p.now]
 * Each person carries `actions: { change, edit }` (selfService.js), registrations rows then also
 * need email, guardian_profile_id, team_id and settings closes_at, runner_competition_change,
 * runner_data_edit; without them both are false.
 */
export function shapeMyRegistrations({ userId, email = null, settings, orders, registrations, competitions, refunded = new Map(), liveOrderIds = null, captains = new Set(), openSurcharges = [], enabledClubs = new Set(), now = new Date() }) {
  const settingsOf = new Map(settings.filter((s) => s.state !== 'draft').map((s) => [s.event_id, s]))
  const compName = new Map(competitions.map((c) => [c.category_id, c.name]))
  const events = new Map()
  const eventFor = (eventId) => {
    const s = settingsOf.get(eventId)
    if (!s) return null
    if (!events.has(eventId)) {
      events.set(eventId, {
        eventId,
        slug: s.slug,
        eventName: s.name ?? null,
        eventDate: s.event_date ?? null,
        firstStartTime: s.first_start_time ? String(s.first_start_time).slice(0, 5) : null,
        orders: [],
        people: [],
      })
    }
    return events.get(eventId)
  }

  const isSurcharge = (o) => o.kind === 'surcharge'
  const surcharges = orders.filter((o) => isSurcharge(o) && o.buyer_profile_id === userId)
  const seenOrders = new Set()
  for (const o of [...orders].sort(byCreated)) {
    if (isSurcharge(o) || seenOrders.has(o.id) || o.buyer_profile_id !== userId || !LISTED_ORDER_STATUSES.includes(o.status)) continue
    const ev = eventFor(o.event_id)
    if (!ev) continue
    seenOrders.add(o.id)
    ev.orders.push({
      id: o.id,
      status: o.status,
      total: o.total,
      refunded: refunded.get(o.id) ?? 0,
      cancelled: o.status === 'paid' && liveOrderIds != null && !liveOrderIds.has(o.id),
      expiresAt: o.expires_at ?? null,
      paidAt: o.paid_at ?? null,
      createdAt: o.created_at ?? null,
    })
  }

  const seenRegs = new Set()
  for (const r of [...registrations].sort(byCreated)) {
    if (seenRegs.has(r.id) || !LISTED_REGISTRATION_STATUSES.includes(r.status)) continue
    const ev = eventFor(r.event_id)
    if (!ev) continue
    seenRegs.add(r.id)
    const surcharge = pendingSurcharge(r.id, surcharges, compName, now)
    const anySurcharge = surcharge != null || pendingSurcharge(r.id, openSurcharges, compName, now) != null
    const s = settingsOf.get(r.event_id)
    ev.people.push({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      competition: compName.get(r.category_id) ?? null,
      status: r.status,
      mine: r.profile_id != null && r.profile_id === userId,
      surcharge,
      actions: selfServiceActions({
        reg: r, settings: s, session: { userId, email }, clubEnabled: enabledClubs.has(s.club_id),
        captain: captains.has(r.id), surchargeOpen: anySurcharge, now,
      }),
    })
  }

  for (const ev of events.values()) {
    // The session's own entry first, the rest in the order they were made.
    ev.people.sort((a, b) => Number(b.mine) - Number(a.mine))
  }
  const today = warsawToday(now)
  return [...events.values()]
    .filter((ev) => ev.orders.length > 0 || ev.people.length > 0)
    .sort((a, b) => compareEvents(a, b, today))
}
