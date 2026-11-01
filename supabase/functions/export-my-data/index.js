// supabase/functions/export-my-data/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { registeredByNames } from '../_shared/registration/registeredBy.js'

const POLICY_VERSION = '2026-06-04'

// PostgREST answers at most 1000 rows per request, so a list that can grow is
// read in pages; a bare select would silently truncate an Art. 15 export.
// Like the other lists in this export, a failing query degrades to an empty
// list with a log line instead of failing the whole Art. 15 export.
async function fetchAll(buildQuery, label) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await buildQuery().range(from, from + 999)
    if (error) {
      console.error(`export-my-data: ${label} failed:`, error.code, error.message)
      return []
    }
    rows.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  return rows
}

// Plan 4 (groups): an entry somebody else made for this person (an added adult) says who provided
// the data (Art. 14(2)(f), Art. 15(1)(g)) as `registered_by` (the name the buyer typed on the
// order, never their account id or address), and carries the consent request's dates. The token
// hash is never exported: it is a credential, not information about the person.
const REGISTRATION_COLUMNS = 'id, event_id, category_id, status, first_name, last_name, birth_date, gender, email, phone, city, club, nationality, '
  + 'ice_name, ice_phone, guardian_name, guardian_email, guardian_removed_at, age_group_label, list_price, price, refunded, consent_state, created_at, '
  + 'order_id, registered_by_profile_id, team_id, '
  + 'registration_settings(name, event_date), '
  + 'consent_acceptances(consent_kind, accepted_as, regulamin_version, accepted_at, ip, user_agent), '
  + 'consent_requests(sent_at, emailed_at, last_reminded_at, auto_reminded_at, used_at, expires_at)'

// Plan 7: package transfers (§2). The token's SHA-256 is a credential and is never exported. No
// partner or voucher field exists on a transfer, and REGISTRATION_COLUMNS above keeps leaving out
// partner_id and voucher_id (D7-11): partner attribution is the organizer's, never the runner's.
const TRANSFER_COLUMNS = 'id, event_id, registration_id, new_registration_id, kind, status, from_profile_id, to_email, '
  + 'accepted_by_profile_id, created_at, expires_at, accepted_at, cancelled_at, registration_settings(name, event_date, club_id)'

const GUARDIAN_COLUMNS = 'id, event_id, status, first_name, last_name, guardian_name, guardian_email, guardian_removed_at, created_at, '
  + 'registration_settings(name, event_date), '
  + 'consent_acceptances(consent_kind, accepted_as, accepted_by_profile_id, regulamin_version, accepted_at, ip, user_agent)'

// Paid registration (plan 3): the order with its frozen amounts, its lines, every dpay
// transaction started for it and every refund. The operator alerts raised about the order are
// included too: they are about this person's payment, even if they are an internal note.
// payment_events (the raw dpay log) is not: it holds the same transaction ids and amounts, and
// the payer address only as a SHA-256.
const ORDER_COLUMNS = 'id, status, buyer_email, buyer_name, entry_total, extras_total, donation, '
  + 'total, created_at, expires_at, paid_at, paid_transaction_id, cancelled_at, cancelled_reason, '
  + 'registration_settings(name, event_date), '
  + 'order_lines(kind, registration_id, qty, amount, refunded, tier_label, tier_ends_on), '
  + 'payment_attempts(id, dpay_transaction_id, grosze, status, created_at, paid_at), '
  + 'refunds(id, payment_attempt_id, amount, kind, reason, dpay_status, created_at), '
  + 'operator_alerts(kind, payload, created_at)'

function orderView(o) {
  return {
    id: o.id,
    event_name: o.registration_settings?.name ?? null,
    event_date: o.registration_settings?.event_date ?? null,
    status: o.status,
    buyer_email: o.buyer_email,
    buyer_name: o.buyer_name ?? null,
    amounts: {
      entry_total: o.entry_total, extras_total: o.extras_total, donation: o.donation,
      total: o.total,
    },
    created_at: o.created_at,
    expires_at: o.expires_at,
    paid_at: o.paid_at,
    paid_transaction_id: o.paid_transaction_id,
    cancelled_at: o.cancelled_at,
    cancelled_reason: o.cancelled_reason,
    lines: o.order_lines ?? [],
    payment_attempts: o.payment_attempts ?? [],
    refunds: o.refunds ?? [],
    alerts: o.operator_alerts ?? [],
  }
}

// „Napisz do zawodnika” (Plan 6): a message to one person stores their registration id in
// organizer_messages.filter, so it is their data. sent_by stays out: the export says the message
// came from the event's organizer and nothing about which member of the club wrote it. A bulk
// message is stored per event, never per recipient, so it belongs to nobody's export.
const ORGANIZER_MESSAGE_FROM = 'Organizator wydarzenia'

function organizerMessageView(m) {
  return {
    event_name: m.registration_settings?.name ?? null,
    event_date: m.registration_settings?.event_date ?? null,
    from: ORGANIZER_MESSAGE_FROM,
    subject: m.subject,
    body: m.body,
    sent_at: m.sent_at,
  }
}

function json(body, status, req, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...extraHeaders },
  })
}

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, req)
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) {
    return json({ error: 'Unauthorized' }, 401, req)
  }

  const userId = session.userId

  const [
    profile, userBadges, consentLog, eventReports, websiteFeedback, submittedEvents, favorites,
    clubMemberships, ownedClubsRaw, membershipLog, raceEntries, invitesToMe,
    organizerAgreements, organizerActions, payoutHistory, waitlistRequests,
    registrationsByProfile, registrationsByEmail, guardianByProfile, guardianByEmail,
    ordersByProfile, ordersByEmail, eventPayoutHistory,
  ] = await Promise.all([
    supabaseAdmin.from('profiles').select('*').eq('id', userId).single(),
    supabaseAdmin.from('user_badges').select('*').eq('user_id', userId),
    supabaseAdmin.from('consent_log').select('*').eq('user_id', userId),
    supabaseAdmin.from('calendar_event_reports').select('*').eq('user_id', userId),
    supabaseAdmin.from('website_feedback').select('*').eq('user_id', userId),
    supabaseAdmin.from('calendar_events').select('*').eq('submitted_by', userId),
    supabaseAdmin.from('event_favorites').select('event_id, created_at, calendar_events(name, date)').eq('user_id', userId),
    supabaseAdmin.from('club_members')
      .select('role, status, joined_at, left_at, hidden_public, clubs(name)')
      .eq('user_id', userId),
    supabaseAdmin.from('clubs').select('id, name, description').eq('owner_id', userId),
    supabaseAdmin.from('club_membership_log')
      .select('event, role, occurred_at, clubs(name)')
      .eq('user_id', userId)
      .order('occurred_at'),
    // Race entries are matched to a person by email, which is exactly how
    // delete-my-account finds them to anonymise — so the system already treats
    // them as this user's personal data, and an Art. 15 export that omits them
    // is incomplete. A runner downloading their data got no trace of the races
    // they had actually entered.
    session.email
      ? supabaseAdmin.from('participants')
        .select('first_name, last_name, email, phone, bib_number, club, checked_in, checked_in_at, deleted_at, events(name, date)')
        .eq('email', session.email)
      : Promise.resolve({ data: [] }),
    // Invitations addressed to them, which they can neither see nor act on
    // anywhere else once the club has them.
    session.email
      ? supabaseAdmin.from('club_invites')
        .select('kind, target_email, target_username, created_at, expires_at, revoked, clubs(name)')
        .eq('target_email', session.email)
      : Promise.resolve({ data: [] }),
    // Organizer records the person produced. Stable order keeps .range() paging exact.
    fetchAll(() => supabaseAdmin.from('organizer_agreements')
      .select('id, club_name, version, accepted_at, ip, user_agent')
      .eq('accepted_by', userId).order('accepted_at').order('id'), 'organizer_agreements'),
    fetchAll(() => supabaseAdmin.from('organizer_actions')
      .select('id, action, target, payload, ip, user_agent, created_at, clubs(name)')
      .eq('actor_id', userId).order('created_at').order('id'), 'organizer_actions'),
    // old/new hold the full IBAN and NIP exactly as stored: the person who made
    // the change already sees them in the club's payout screen, so the export
    // does not mask them.
    fetchAll(() => supabaseAdmin.from('club_payout_history')
      .select('id, club_name, old, new, changed_at')
      .eq('changed_by', userId).order('changed_at').order('id'), 'club_payout_history'),
    fetchAll(() => supabaseAdmin.from('registration_waitlist')
      .select('created_at, clubs(name)')
      .eq('requested_by', userId).order('created_at').order('club_id'), 'registration_waitlist'),
    // Online registrations, by profile or by the address they were made with
    // (delete-my-account anonymises by the same two keys), with the consents
    // accepted for each one.
    fetchAll(() => supabaseAdmin.from('registrations')
      .select(REGISTRATION_COLUMNS).eq('profile_id', userId).order('created_at').order('id'), 'registrations by profile'),
    session.email
      ? fetchAll(() => supabaseAdmin.from('registrations')
        .select(REGISTRATION_COLUMNS).eq('email', session.email.toLowerCase().trim()).order('created_at').order('id'), 'registrations by email')
      : Promise.resolve([]),
    // Registrations they made as guardian of somebody else.
    fetchAll(() => supabaseAdmin.from('registrations')
      .select(GUARDIAN_COLUMNS).eq('guardian_profile_id', userId).order('created_at').order('id'), 'guardian registrations by profile'),
    session.email
      ? fetchAll(() => supabaseAdmin.from('registrations')
        .select(GUARDIAN_COLUMNS).eq('guardian_email', session.email.toLowerCase().trim()).order('created_at').order('id'), 'guardian registrations by email')
      : Promise.resolve([]),
    // Orders they placed: by account, and by the address (as registrations above).
    fetchAll(() => supabaseAdmin.from('orders')
      .select(ORDER_COLUMNS).eq('buyer_profile_id', userId).order('created_at').order('id'), 'orders by profile'),
    session.email
      ? fetchAll(() => supabaseAdmin.from('orders')
        .select(ORDER_COLUMNS).eq('buyer_email', session.email.toLowerCase().trim()).order('created_at').order('id'), 'orders by email')
      : Promise.resolve([]),
    // Payout changes of one event, made by this person as the club owner. Like
    // club_payout_history, old/new are the club's account (or the recipient the
    // club named) exactly as stored. The current event_payout_details row belongs
    // to the club's event, not to the person, so it is not exported.
    fetchAll(() => supabaseAdmin.from('event_payout_history')
      .select('id, event_id, old, new, changed_at, registration_settings(name)')
      .eq('changed_by', userId).order('changed_at').order('id'), 'event_payout_history'),
  ])

  const orders = [...new Map([...ordersByProfile, ...ordersByEmail].map((o) => [o.id, o])).values()]
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(orderView)

  const registrationsAsGuardian = [...new Map([...guardianByProfile, ...guardianByEmail].map((r) => [r.id, r])).values()]
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(({ registration_settings: rs, ...r }) => ({
      ...r,
      event_name: rs?.name ?? null,
      event_date: rs?.event_date ?? null,
    }))

  const ownRegs = [...new Map([...registrationsByProfile, ...registrationsByEmail].map((r) => [r.id, r])).values()]
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  // Rows registered by another account: who that was is the source of the data (Art. 14(2)(f)),
  // named by registeredByNames, the consent e-mail's rule (final review I-2): the name the buyer
  // typed on the order, else (a free group has no order) the buyer's own entry, the guardian name
  // their children carry, the display name. The buyer's own rows and their order stay out of this
  // export. An added adult's row always has a consent request; registered_by_profile_id alone is
  // not enough, because delete-my-account nulls it when the buyer deletes their account.
  const consentRequestOf = (r) => (Array.isArray(r.consent_requests) ? r.consent_requests[0] : r.consent_requests) ?? null
  const addedBySomebody = (r) => (r.registered_by_profile_id && r.registered_by_profile_id !== userId) || consentRequestOf(r) != null
  const byOthers = ownRegs.filter(addedBySomebody)
  let registeredBy = () => null
  if (byOthers.length > 0) {
    try {
      registeredBy = await registeredByNames(supabaseAdmin, byOthers)
    } catch (err) {
      console.error('export-my-data: registered_by names failed:', err?.message)
    }
  }
  // Plan 5: a team the person runs in. Everyone gets its name on their own entry; the captain, who
  // typed it, also gets the team as a record. The squad's size is a number: the other adults'
  // entries are their data (the children are in registrations_as_guardian).
  const teamIds = [...new Set(ownRegs.map((r) => r.team_id).filter(Boolean))]
  const [teamRows, teamMembers] = teamIds.length > 0
    ? await Promise.all([
      fetchAll(() => supabaseAdmin.from('teams')
        .select('id, name, captain_registration_id, created_at, competitions(name), registration_settings(name, event_date)')
        .in('id', teamIds).order('created_at').order('id'), 'teams'),
      fetchAll(() => supabaseAdmin.from('registrations')
        .select('team_id').in('team_id', teamIds).in('status', ['confirmed', 'pending_payment']).order('id'), 'team sizes'),
    ])
    : [[], []]
  const teamById = new Map(teamRows.map((t) => [t.id, t]))
  const teams = teamRows
    .filter((t) => ownRegs.some((r) => r.id === t.captain_registration_id))
    .map((t) => ({
      name: t.name,
      competition: t.competitions?.name ?? null,
      event_name: t.registration_settings?.name ?? null,
      event_date: t.registration_settings?.event_date ?? null,
      size: teamMembers.filter((m) => m.team_id === t.id).length,
      status: ownRegs.find((r) => r.id === t.captain_registration_id).status,
      created_at: t.created_at,
    }))

  // Plan 7: the transfers of the person's packages (sent) and those addressed to them (received).
  //   sent: every transfer of an entry they held, the invites they typed and an organizer's. The
  //     address they typed themselves is theirs to see; an organizer's recipient is not (ruling N-1:
  //     the old holder did not choose them), so it stays out, as does every name of a recipient.
  //   received: an invite to their address (open or not), a link they took (also a forwarded one)
  //     and an organizer transfer to them. `from_name` is who gave LESZY.RUN their address
  //     (Art. 14(2)(f)): the sender's first name, as the invite showed it, or the organizer's club.
  //     to_email is kept only when it is their own address: a forwarded link's invited address
  //     belongs to the person it was sent to.
  const myEmail = session.email ? session.email.toLowerCase().trim() : null
  const ownRegIds = ownRegs.map((r) => r.id)
  const transferLists = await Promise.all([
    ownRegIds.length
      ? fetchAll(() => supabaseAdmin.from('transfers').select(TRANSFER_COLUMNS)
        .in('registration_id', ownRegIds).order('created_at').order('id'), 'transfers of own entries')
      : Promise.resolve([]),
    fetchAll(() => supabaseAdmin.from('transfers').select(TRANSFER_COLUMNS)
      .eq('from_profile_id', userId).eq('kind', 'runner').order('created_at').order('id'), 'transfers sent'),
    ownRegIds.length
      ? fetchAll(() => supabaseAdmin.from('transfers').select(TRANSFER_COLUMNS)
        .in('new_registration_id', ownRegIds).order('created_at').order('id'), 'transfers into own entries')
      : Promise.resolve([]),
    fetchAll(() => supabaseAdmin.from('transfers').select(TRANSFER_COLUMNS)
      .eq('accepted_by_profile_id', userId).order('created_at').order('id'), 'transfers accepted'),
    myEmail
      ? fetchAll(() => supabaseAdmin.from('transfers').select(TRANSFER_COLUMNS)
        .eq('to_email', myEmail).order('created_at').order('id'), 'transfers to address')
      : Promise.resolve([]),
  ])
  const uniqueTransfers = (lists) => [...new Map(lists.flat().map((t) => [t.id, t])).values()]
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))
  const sentRows = uniqueTransfers(transferLists.slice(0, 2))
  const receivedRows = uniqueTransfers(transferLists.slice(2))
  // Who gave the recipient's address: the sender's first name (as in the invite), the club for an
  // organizer transfer. One read of each, by id.
  const senderRegIds = [...new Set(receivedRows.filter((t) => t.kind === 'runner').map((t) => t.registration_id))]
  const clubIds = [...new Set(receivedRows.filter((t) => t.kind === 'organizer')
    .map((t) => t.registration_settings?.club_id).filter(Boolean))]
  const [senderRegs, transferClubs] = await Promise.all([
    senderRegIds.length
      ? fetchAll(() => supabaseAdmin.from('registrations').select('id, first_name').in('id', senderRegIds).order('id'), 'transfer senders')
      : Promise.resolve([]),
    clubIds.length
      ? fetchAll(() => supabaseAdmin.from('clubs').select('id, name').in('id', clubIds).order('id'), 'transfer clubs')
      : Promise.resolve([]),
  ])
  const senderName = new Map(senderRegs.map((r) => [r.id, r.first_name?.trim() || null]))
  const clubName = new Map(transferClubs.map((c) => [c.id, c.name?.trim() || null]))
  const transferBase = (t) => ({
    id: t.id,
    event_id: t.event_id,
    event_name: t.registration_settings?.name ?? null,
    event_date: t.registration_settings?.event_date ?? null,
    kind: t.kind,
    status: t.status,
    created_at: t.created_at,
    expires_at: t.expires_at,
    accepted_at: t.accepted_at,
    cancelled_at: t.cancelled_at,
  })
  const transfers = {
    // Each side gets its own registration's id only: the other one belongs to the other person.
    sent: sentRows.map((t) => ({
      ...transferBase(t),
      registration_id: t.registration_id,
      to_email: t.kind === 'runner' ? t.to_email : null,
    })),
    received: receivedRows.map((t) => ({
      ...transferBase(t),
      new_registration_id: t.new_registration_id,
      to_email: myEmail && t.to_email === myEmail ? t.to_email : null,
      from_name: t.kind === 'organizer'
        ? clubName.get(t.registration_settings?.club_id) ?? 'Organizator zawodów'
        : senderName.get(t.registration_id) ?? null,
    })),
  }

  const registrations = ownRegs
    .map((row) => {
      const { registration_settings: rs, consent_requests: _cr, order_id: _order, registered_by_profile_id: _by, team_id: teamId, ...r } = row
      return {
        ...r,
        event_name: rs?.name ?? null,
        event_date: rs?.event_date ?? null,
        team_name: teamId ? teamById.get(teamId)?.name ?? null : null,
        // null: the person registered themself. Otherwise { name }: the name is null when nothing
        // names the buyer any more (they deleted their account: registered_by and buyer_name go).
        registered_by: addedBySomebody(row) ? { name: registeredBy(row) } : null,
        consent_request: consentRequestOf(row),
      }
    })

  // A message on a child's entry went to the guardian (resolveAudience), so it is theirs too.
  const messagedRegistrationIds = [...ownRegs, ...registrationsAsGuardian].map((r) => r.id)
  const organizerMessages = messagedRegistrationIds.length > 0
    ? await fetchAll(() => supabaseAdmin.from('organizer_messages')
      .select('id, subject, body, sent_at, registration_settings(name, event_date)')
      .eq('filter->>kind', 'single').in('filter->>registrationId', messagedRegistrationIds)
      .order('sent_at').order('id'), 'organizer_messages')
    : []

  const memberships = (clubMemberships.data ?? []).map((m) => ({
    club_name: m.clubs?.name ?? null,
    role: m.role,
    status: m.status,
    joined_at: m.joined_at,
    left_at: m.left_at,
    hidden_public: m.hidden_public,
  }))
  const membership_history = (membershipLog.data ?? []).map((e) => ({
    club_name: e.clubs?.name ?? null,
    event: e.event,
    role: e.role,
    occurred_at: e.occurred_at,
  }))

  // Legacy key kept for backward compatibility — CI (clubs-lifecycle.test.js) still
  // asserts `clubs.membership` as the single active-membership shape the export used
  // to return before `memberships`/`membership_history` were added.
  const activeMembership = (clubMemberships.data ?? []).find((m) => m.status === 'active') ?? null
  const membership = activeMembership
    ? {
        club_name: activeMembership.clubs?.name ?? null,
        role: activeMembership.role,
        status: activeMembership.status,
        joined_at: activeMembership.joined_at,
        hidden_public: activeMembership.hidden_public,
        club_public_name: profile.data?.privacy_settings?.club_public_name ?? null,
      }
    : null

  const owned = []
  for (const c of ownedClubsRaw.data || []) {
    const { count } = await supabaseAdmin
      .from('club_members')
      .select('*', { count: 'exact', head: true })
      .eq('club_id', c.id)
    owned.push({ name: c.name, description: c.description ?? null, member_count: count ?? 0 })
  }

  const body = {
    exported_at: new Date().toISOString(),
    policy_version_at_export: POLICY_VERSION,
    account: profile.data || null,
    badges: userBadges.data || [],
    consent_log: consentLog.data || [],
    favorites: favorites.data || [],
    contributions: {
      calendar_event_reports: eventReports.data || [],
      website_feedback: websiteFeedback.data || [],
      submitted_calendar_events: submittedEvents.data || [],
    },
    clubs: { membership, memberships, membership_history, owned },
    registrations,
    registrations_as_guardian: registrationsAsGuardian,
    teams,
    transfers,
    orders,
    organizer_messages_received: organizerMessages.map(organizerMessageView),
    race_entries: (raceEntries.data ?? []).map((p) => ({
      event_name: p.events?.name ?? null,
      event_date: p.events?.date ?? null,
      first_name: p.first_name,
      last_name: p.last_name,
      email: p.email,
      phone: p.phone,
      bib_number: p.bib_number,
      club: p.club,
      checked_in: p.checked_in,
      checked_in_at: p.checked_in_at,
      anonymised_at: p.deleted_at,
    })),
    organizer: {
      agreements_accepted: organizerAgreements.map((a) => ({
        club_name: a.club_name,
        version: a.version,
        accepted_at: a.accepted_at,
        ip: a.ip,
        user_agent: a.user_agent,
      })),
      actions: organizerActions.map((a) => ({
        club_name: a.clubs?.name ?? null,
        action: a.action,
        target: a.target,
        payload: a.payload,
        ip: a.ip,
        user_agent: a.user_agent,
        created_at: a.created_at,
      })),
      payout_changes: payoutHistory.map((h) => ({
        club_name: h.club_name,
        old: h.old,
        new: h.new,
        changed_at: h.changed_at,
      })),
      event_payout_changes: eventPayoutHistory.map((h) => ({
        event_id: h.event_id,
        event_name: h.registration_settings?.name ?? null,
        old: h.old,
        new: h.new,
        changed_at: h.changed_at,
      })),
      waitlist_requests: waitlistRequests.map((w) => ({
        club_name: w.clubs?.name ?? null,
        requested_at: w.created_at,
      })),
    },
    club_invitations_received: (invitesToMe.data ?? []).map((i) => ({
      club_name: i.clubs?.name ?? null,
      kind: i.kind,
      target_email: i.target_email,
      target_username: i.target_username,
      created_at: i.created_at,
      expires_at: i.expires_at,
      revoked: i.revoked,
    })),
  }

  const date = new Date().toISOString().slice(0, 10)
  return json(body, 200, req, {
    'Content-Disposition': `attachment; filename="leszy-run-dane-${userId}-${date}.json"`,
  })
})
