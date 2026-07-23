import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { checkAndAwardBadges } from '../_shared/badge-check.js'
import { logMembershipEvent } from '../_shared/membershipLog.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// Caller must be owner/admin (active) of the club
async function requireManager(supabaseAdmin, clubId, userId) {
  const { data } = await supabaseAdmin.from('club_members')
    .select('role').eq('club_id', clubId).eq('user_id', userId).eq('status', 'active').maybeSingle()
  return data && (data.role === 'owner' || data.role === 'admin')
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
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try {
    const { club_id, user_id, action } = await req.json()
    if (!club_id || !user_id || !['approve', 'reject'].includes(action)) {
      return json({ error: 'club_id, user_id, action required' }, 400, req)
    }
    if (!(await requireManager(supabaseAdmin, club_id, session.userId))) {
      return json({ error: 'Brak uprawnień.' }, 403, req)
    }

    const { data: pending } = await supabaseAdmin.from('club_members')
      .select('status').eq('club_id', club_id).eq('user_id', user_id).maybeSingle()
    if (!pending || pending.status !== 'pending') {
      return json({ error: 'Brak oczekującego zgłoszenia.' }, 404, req)
    }

    if (action === 'reject') {
      await supabaseAdmin.from('club_members').delete().eq('club_id', club_id).eq('user_id', user_id)
      return json({ data: { status: 'rejected' } }, 200, req)
    }

    // approve — guard: the joiner must not have become active elsewhere meanwhile
    const { data: activeElsewhere } = await supabaseAdmin.from('club_members')
      .select('club_id').eq('user_id', user_id).eq('status', 'active').maybeSingle()
    if (activeElsewhere) return json({ error: 'Użytkownik należy już do innego klubu.' }, 409, req)

    await supabaseAdmin.from('club_members')
      .update({ status: 'active', joined_at: new Date().toISOString() })
      .eq('club_id', club_id).eq('user_id', user_id)
    await supabaseAdmin.from('profiles').update({ club_id }).eq('id', user_id)

    await logMembershipEvent(supabaseAdmin, {
      club_id, user_id, event: 'joined', role: 'member', actor_id: session.userId,
    })

    // Award the club_set badge to the newly-active member (best-effort).
    await checkAndAwardBadges(supabaseAdmin, user_id)

    return json({ data: { status: 'active' } }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
