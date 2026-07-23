// supabase/functions/export-my-data/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

const POLICY_VERSION = '2026-06-04'

function json(body, status, req, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...extraHeaders },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

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
    clubMemberships, ownedClubsRaw, membershipLog,
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
  }

  const date = new Date().toISOString().slice(0, 10)
  return json(body, 200, req, {
    'Content-Disposition': `attachment; filename="leszy-run-dane-${userId}-${date}.json"`,
  })
})
