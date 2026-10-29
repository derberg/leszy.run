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
  + 'order_id, registered_by_profile_id, '
  + 'registration_settings(name, event_date), '
  + 'consent_acceptances(consent_kind, accepted_as, regulamin_version, accepted_at, ip, user_agent), '
  + 'consent_requests(sent_at, emailed_at, last_reminded_at, auto_reminded_at, used_at, expires_at)'

const GUARDIAN_COLUMNS = 'id, event_id, status, first_name, last_name, guardian_name, guardian_email, guardian_removed_at, created_at, '
  + 'registration_settings(name, event_date), '
  + 'consent_acceptances(consent_kind, accepted_as, accepted_by_profile_id, regulamin_version, accepted_at, ip, user_agent)'

// Paid registration (plan 3): the order with its frozen amounts, its lines, every dpay
// transaction started for it and every refund. The operator alerts raised about the order are
// included too: they are about this person's payment, even if they are an internal note.
// payment_events (the raw dpay log) is not: it holds the same transaction ids and amounts, and
// the payer address only as a SHA-256.
const ORDER_COLUMNS = 'id, status, buyer_email, buyer_name, support_choice, entry_total, extras_total, donation, support_fee, '
  + 'payment_fee, total, created_at, expires_at, paid_at, paid_transaction_id, cancelled_at, cancelled_reason, '
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
    support_choice: o.support_choice,
    amounts: {
      entry_total: o.entry_total, extras_total: o.extras_total, donation: o.donation,
      support_fee: o.support_fee, payment_fee: o.payment_fee, total: o.total,
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
  const registrations = ownRegs
    .map((row) => {
      const { registration_settings: rs, consent_requests: _cr, order_id: _order, registered_by_profile_id: _by, ...r } = row
      return {
        ...r,
        event_name: rs?.name ?? null,
        event_date: rs?.event_date ?? null,
        // null: the person registered themself. Otherwise { name }: the name is null when nothing
        // names the buyer any more (they deleted their account: registered_by and buyer_name go).
        registered_by: addedBySomebody(row) ? { name: registeredBy(row) } : null,
        consent_request: consentRequestOf(row),
      }
    })

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
    orders,
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
