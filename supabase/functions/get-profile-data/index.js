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
  ] = await Promise.all([
    supabaseAdmin
      .from('profiles')
      .select('id, email, username, display_name, club_id, clubs(name), privacy_settings, created_at, gender, phone, date_of_birth, city, voivodeship, weekly_digest')
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
  ])

  const profileOut = profile
    ? (() => { const p = { ...profile, club: profile.clubs?.name ?? null }; delete p.clubs; return p })()
    : profile

  return json({ profile: profileOut, badges: badges ?? [], reports: reports ?? [], submissions: submissions ?? [] }, 200, req)
})
