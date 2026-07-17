// supabase/functions/get-profile-data/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Not authenticated' }, 401, req)

  const [
    { data: profile },
    { data: badges },
    { data: reports },
    { data: submissions },
    { data: pendingMembership },
    { data: pendingOwnership },
  ] = await Promise.all([
    supabaseAdmin
      .from('profiles')
      .select('id, email, username, display_name, club_id, clubs!profiles_club_id_fkey(name), privacy_settings, created_at, gender, phone, date_of_birth, city, voivodeship, weekly_digest')
      .eq('id', session.userId)
      .single(),
    supabaseAdmin
      .from('user_badges')
      .select('*, badge_definitions(*)')
      .eq('user_id', session.userId),
    supabaseAdmin
      .from('calendar_event_reports')
      .select('*')
      .eq('user_id', session.userId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabaseAdmin
      .from('calendar_events')
      .select('id, name, status, created_at')
      .eq('submitted_by', session.userId)
      .order('created_at', { ascending: false })
      .limit(50),
    // Caller's own pending join request (at most one — enforced by the
    // request-join/respond-join flow). club_members has a single FK to
    // clubs (club_id), so a bare clubs(name) embed here is unambiguous.
    supabaseAdmin
      .from('club_members')
      .select('club_id, clubs(name)')
      .eq('user_id', session.userId)
      .eq('status', 'pending')
      .maybeSingle(),
    // Clubs where the caller has been nominated as the incoming owner.
    supabaseAdmin
      .from('clubs')
      .select('id, name, slug')
      .eq('pending_owner_id', session.userId),
  ])

  const profileOut = profile
    ? (() => { const p = { ...profile, club: profile.clubs?.name ?? null }; delete p.clubs; return p })()
    : profile

  // Direct club invites addressed to this caller (by email or username).
  // Needs profile.username, so it runs after the batch above resolves.
  const orTarget = profile?.username
    ? `target_email.eq.${session.email},target_username.eq.${profile.username}`
    : `target_email.eq.${session.email}`
  const nowIso = new Date().toISOString()
  const { data: invites } = await supabaseAdmin
    .from('club_invites')
    .select('id, club_id, clubs(name)')
    .eq('kind', 'direct')
    .eq('revoked', false)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .or(orTarget)

  return json({
    profile: profileOut,
    badges: badges ?? [],
    reports: reports ?? [],
    submissions: submissions ?? [],
    pending_membership: pendingMembership
      ? { club_id: pendingMembership.club_id, club_name: pendingMembership.clubs?.name ?? null }
      : null,
    pending_ownership: pendingOwnership ?? [],
    incoming_invites: (invites ?? []).map((i) => ({
      id: i.id, club_id: i.club_id, club_name: i.clubs?.name ?? null,
    })),
  }, 200, req)
})
