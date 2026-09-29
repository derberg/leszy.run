// supabase/functions/export-my-data/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

const POLICY_VERSION = '2026-06-04'

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
  ])

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
