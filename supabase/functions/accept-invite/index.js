import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { checkAndAwardBadges } from '../_shared/badge-check.js'

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
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try {
    const { code, invite_id } = await req.json()
    if (!code && !invite_id) {
      return json({ error: 'code or invite_id required' }, 400, req)
    }

    let query = supabaseAdmin.from('club_invites')
      .select('id, club_id, kind, expires_at, max_uses, uses, revoked')
    query = invite_id ? query.eq('id', invite_id) : query.eq('code', code)
    const { data: invite } = await query.maybeSingle()

    if (!invite) return json({ error: 'Nieprawidłowy kod zaproszenia.' }, 404, req)
    if (invite.revoked) return json({ error: 'Zaproszenie zostało cofnięte.' }, 410, req)
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return json({ error: 'Zaproszenie wygasło.' }, 410, req)
    }
    if (invite.max_uses != null && invite.uses >= invite.max_uses) {
      return json({ error: 'Zaproszenie wyczerpane.' }, 409, req)
    }

    // Enforce ≤1 active membership per user
    const { data: activeElsewhere } = await supabaseAdmin.from('club_members')
      .select('club_id').eq('user_id', session.userId).eq('status', 'active').maybeSingle()
    if (activeElsewhere) {
      return json({ error: 'Należysz już do klubu. Opuść go, aby dołączyć do innego.' }, 409, req)
    }

    const { data: club, error: clubErr } = await supabaseAdmin.from('clubs')
      .select('id, slug, name').eq('id', invite.club_id).single()
    if (clubErr) throw clubErr

    const { error: memErr } = await supabaseAdmin.from('club_members')
      .upsert({
        club_id: invite.club_id,
        user_id: session.userId,
        role: 'member',
        status: 'active',
        joined_at: new Date().toISOString(),
      }, { onConflict: 'club_id,user_id' })
    if (memErr) throw memErr

    await supabaseAdmin.from('profiles').update({ club_id: invite.club_id }).eq('id', session.userId)

    if (invite.kind === 'link') {
      await supabaseAdmin.from('club_invites').update({ uses: invite.uses + 1 }).eq('id', invite.id)
    }

    // Award the club_set badge now that the user has a club (best-effort).
    await checkAndAwardBadges(supabaseAdmin, session.userId)

    return json({ data: { club, status: 'active' } }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
