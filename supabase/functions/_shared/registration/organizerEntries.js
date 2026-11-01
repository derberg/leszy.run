// The organizer panel's rows (B3): every registration of one event, read on the service role and
// shaped for the panel and the CSV. Shared by list-event-registrations and
// export-event-registrations, so the export holds exactly what the panel shows. The caller has
// already checked that the session is the owner or an admin of the event's club.
import { allRows } from './allRows.js'
import { paymentStatusOf, registrationRole } from './group.js'
import { entryStatusKey, unconfirmedRefundGrosze } from './entries.js'

const LIVE = new Set(['confirmed', 'pending_payment'])
const ID_CHUNK = 100
// An entry whose person deleted the account reads „Usunięte konto Usunięte konto”: not a name.
const DELETED = 'Usunięte konto'
const fullName = (r) => (r.first_name === DELETED ? null : `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim())
const roleOf = registrationRole

const REG_COLUMNS = 'id, category_id, order_id, first_name, last_name, birth_date, gender, phone, city, club, nationality, ' +
  'ice_name, ice_phone, email, age_group_label, status, created_at, price, partner_id, participant_id, profile_id, ' +
  'registered_by_profile_id, consent_state, guardian_profile_id, guardian_name, guardian_removed_at, team_id'

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

const groupBy = (items, key) => {
  const out = new Map()
  for (const item of items) {
    const k = item[key]
    if (k == null) continue
    if (!out.has(k)) out.set(k, [])
    out.get(k).push(item)
  }
  return out
}

/**
 * Every registration of the event in sign-up order, with the panel's fields.
 * `guardianEmail: true` adds a child's guardian address (the CSV's „E-mail opiekuna”); the panel
 * never gets it. → { rows, counts, teams, competitions, event }
 *
 * Rows keep Plans 2–5's fields (id, name, competition, ageGroupLabel, status, createdAt,
 * paymentStatus, expiresAt, role, consentState, guardianName, guardianRemoved, registeredBy, team)
 * and add:
 *   categoryId, firstName, lastName, birthDate, gender, phone, city, club, nationality, iceName,
 *   icePhone, email     the person, for „Edytuj dane” and the CSV (a deleted account: names null)
 *   bib                 participants.bib_number, null when none
 *   orderId, price      the entry's order and price
 *   lines               [{ id, kind, amount, refunded }]: the order lines of this registration
 *   paidAmount          the lines' total when the order is paid, else 0
 *   refunded            the lines' refunded total, reservations included
 *   refundUnconfirmed   grosze of organizer refunds dpay has not confirmed (in `refunded` too)
 *   statusKey           entryStatusKey, from this row's own refunds and participant
 *   autoRefundReason    'full' when the order was refunded automatically for a full competition
 *   partnerId, partnerName (null: no partner names yet)
 * counts are per person (D5-32), with people's places (placesLeft) and teams' (teamPlacesLeft) apart;
 * competitions are the visible ones (entryCounts' limit).
 */
export async function loadEntries(admin, settings, { guardianEmail = false, now = new Date() } = {}) {
  const eventId = settings.event_id
  const regColumns = guardianEmail ? `${REG_COLUMNS}, guardian_email` : REG_COLUMNS
  const [regs, comps, orders, teamRows, lineRows, refundRows, participants] = await Promise.all([
    allRows(() => admin.from('registrations').select(regColumns)
      .eq('event_id', eventId).order('created_at').order('id')),
    allRows(() => admin.from('competitions').select('category_id, name, capacity, taken, hidden_at, kind')
      .eq('event_id', eventId).order('category_id')),
    allRows(() => admin.from('orders').select('id, total, status, expires_at, buyer_name').eq('event_id', eventId).order('id')),
    allRows(() => admin.from('teams').select('id, name, category_id, captain_registration_id, released_at').eq('event_id', eventId).order('id')),
    allRows(() => admin.from('order_lines').select('id, order_id, kind, registration_id, amount, refunded, orders!inner(event_id)')
      .eq('orders.event_id', eventId).order('id')),
    allRows(() => admin.from('refunds').select('id, order_id, order_line_id, kind, reason, dpay_status, amount, orders!inner(event_id)')
      .eq('orders.event_id', eventId).order('id')),
    allRows(() => admin.from('participants').select('id, registration_id, bib_number, removed_at, withdrawn_at')
      .eq('event_id', eventId).not('registration_id', 'is', null).order('id')),
  ])
  const nameOf = new Map(comps.map((c) => [c.category_id, c.name]))
  const orderOf = new Map(orders.map((o) => [o.id, o]))
  const regOf = new Map(regs.map((r) => [r.id, r]))
  const linesOf = groupBy(lineRows, 'registration_id')
  const refundsOfLine = groupBy(refundRows, 'order_line_id')
  const participantOf = new Map(participants.map((p) => [p.registration_id, p]))
  const fullRefundOrders = new Set(refundRows.filter((f) => f.kind === 'automatic' && f.reason === 'full').map((f) => f.order_id))
  const teamOf = new Map(teamRows.map((t) => {
    const members = regs.filter((r) => r.team_id === t.id && LIVE.has(r.status))
    return [t.id, {
      id: t.id,
      name: t.name,
      size: members.length,
      consentAccepted: members.filter((r) => r.consent_state !== 'awaiting').length,
      fee: regOf.get(t.captain_registration_id)?.price ?? 0,
    }]
  }))
  const orderOfReg = (r) => (r.order_id ? orderOf.get(r.order_id) : null)

  const visible = comps.filter((c) => !c.hidden_at)
  // placesLeft: capacity minus confirmed entries over the visible competitions. Entries
  // awaiting payment hold no place (P3-R15), so they do not lower it. A team competition's
  // places are teams (D5-28), so they never join a person's: placesLeft is the individual
  // competitions' (null on an event of team competitions only), teamPlacesLeft the team
  // competitions' (null when there is none).
  const isTeam = (c) => c.kind === 'team'
  const left = (list) => list.filter((c) => !c.hidden_at)
    .reduce((n, c) => n + Math.max(0, (c.capacity ?? 0) - (c.taken ?? 0)), 0)
  const teamComps = comps.filter(isTeam)
  const placesLeft = teamComps.length && teamComps.length === comps.length ? null : left(comps.filter((c) => !isTeam(c)))
  const teamPlacesLeft = teamComps.length ? left(teamComps) : null
  const counts = { paid: 0, awaiting: 0, free: 0, placesLeft, teamPlacesLeft, awaitingConsent: 0 }
  const registeredBy = await registeredByNames(admin, regs, orderOf)
  const sum = (list, key) => list.reduce((n, x) => n + (x[key] ?? 0), 0)

  const rows = regs.map((r) => {
    const order = orderOfReg(r)
    const team = teamOf.get(r.team_id)
    const paymentStatus = paymentStatusOf(r, order, team?.fee)
    if (paymentStatus) counts[paymentStatus] += 1
    const role = roleOf(r)
    const guardianRemoved = role === 'minor' && r.guardian_removed_at != null
    if (r.status === 'confirmed' && r.consent_state === 'awaiting') counts.awaitingConsent += 1
    const lines = (linesOf.get(r.id) ?? []).map((l) => ({ id: l.id, kind: l.kind, amount: l.amount, refunded: l.refunded }))
    // Only refunds of this row's own lines: an order-level automatic refund belongs to no one row.
    const refunds = lines.flatMap((l) => refundsOfLine.get(l.id) ?? [])
    const participant = participantOf.get(r.id) ?? null
    const expiresAt = paymentStatus === 'awaiting' ? (order?.expires_at ?? null) : null
    const deleted = r.first_name === DELETED
    const row = {
      id: r.id,
      // A deleted account's entry carries the pair „Usunięte konto” „Usunięte konto”: shown once.
      name: deleted ? DELETED : `${r.first_name} ${r.last_name}`,
      competition: nameOf.get(r.category_id) ?? null,
      categoryId: r.category_id,
      ageGroupLabel: r.age_group_label,
      status: r.status,
      createdAt: r.created_at,
      paymentStatus,
      expiresAt,
      role,
      consentState: r.consent_state,
      guardianName: role === 'minor' && !guardianRemoved ? (r.guardian_name ?? null) : null,
      guardianRemoved,
      registeredBy: role === 'self' ? null : registeredBy(r),
      team: team ? { id: team.id, name: team.name, size: team.size, consentAccepted: team.consentAccepted } : null,
      firstName: deleted ? null : r.first_name,
      lastName: deleted ? null : r.last_name,
      birthDate: r.birth_date,
      gender: r.gender,
      phone: r.phone,
      city: r.city,
      club: r.club,
      nationality: r.nationality,
      iceName: r.ice_name,
      icePhone: r.ice_phone,
      email: r.email,
      bib: participant?.bib_number ?? null,
      orderId: r.order_id,
      price: r.price,
      lines,
      paidAmount: order?.status === 'paid' ? sum(lines, 'amount') : 0,
      refunded: sum(lines, 'refunded'),
      refundUnconfirmed: unconfirmedRefundGrosze({ refunds }),
      autoRefundReason: order && fullRefundOrders.has(order.id) ? 'full' : null,
      partnerId: r.partner_id ?? null,
      partnerName: null,
    }
    row.statusKey = entryStatusKey({ ...row, refunds, participant }, now)
    if (guardianEmail) row.guardianEmail = role === 'minor' ? (r.guardian_email ?? null) : null
    return row
  })

  const teams = teamRows.filter((t) => !t.released_at).map((t) => {
    const team = teamOf.get(t.id)
    const captain = regOf.get(t.captain_registration_id)
    const paymentStatus = captain ? paymentStatusOf(captain, orderOfReg(captain), team.fee) : null
    return {
      ...team,
      competition: nameOf.get(t.category_id) ?? null,
      captain: captain ? fullName(captain) : null,
      status: captain?.status ?? null,
      paymentStatus,
      expiresAt: paymentStatus === 'awaiting' ? (orderOfReg(captain)?.expires_at ?? null) : null,
    }
  })

  return {
    rows,
    counts,
    teams,
    competitions: visible.map((c) => ({ id: c.category_id, name: c.name, capacity: c.capacity, taken: c.taken, kind: c.kind })),
    event: { name: settings.name, eventDate: settings.event_date, closesAt: settings.closes_at, state: settings.state },
  }
}
