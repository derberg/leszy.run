import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

async function membership(supabaseAdmin, clubId, userId) {
  const { data } = await supabaseAdmin.from('club_members')
    .select('role, status').eq('club_id', clubId).eq('user_id', userId).maybeSingle()
  return data
}

async function clearClubIdIfPointing(supabaseAdmin, userId, clubId) {
  await supabaseAdmin.from('profiles').update({ club_id: null }).eq('id', userId).eq('club_id', clubId)
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
    const { club_id, action, user_id, role, hidden_public } = await req.json()
    if (!club_id || !action) return json({ error: 'club_id, action required' }, 400, req)

    const me = await membership(supabaseAdmin, club_id, session.userId)
    if (!me || me.status !== 'active') return json({ error: 'Nie należysz do tego klubu.' }, 403, req)

    if (action === 'leave') {
      if (me.role === 'owner') {
        return json({ error: 'Właściciel nie może opuścić klubu — przekaż własność lub usuń klub.' }, 409, req)
      }
      await supabaseAdmin.from('club_members').delete().eq('club_id', club_id).eq('user_id', session.userId)
      await clearClubIdIfPointing(supabaseAdmin, session.userId, club_id)
      return json({ data: { left: true } }, 200, req)
    }

    if (action === 'set-visibility') {
      await supabaseAdmin.from('club_members')
        .update({ hidden_public: !!hidden_public })
        .eq('club_id', club_id).eq('user_id', session.userId)
      return json({ data: { hidden_public: !!hidden_public } }, 200, req)
    }

    // remaining actions target another member → require manager
    const isManager = me.role === 'owner' || me.role === 'admin'
    if (!isManager) return json({ error: 'Brak uprawnień.' }, 403, req)
    if (!user_id) return json({ error: 'user_id required' }, 400, req)

    const target = await membership(supabaseAdmin, club_id, user_id)
    if (!target) return json({ error: 'Nie ma takiego członka.' }, 404, req)
    if (target.role === 'owner') return json({ error: 'Nie można modyfikować właściciela.' }, 403, req)

    if (action === 'remove') {
      // admins may remove members only; owner may remove admins + members
      if (target.role === 'admin' && me.role !== 'owner') {
        return json({ error: 'Tylko właściciel może usunąć administratora.' }, 403, req)
      }
      await supabaseAdmin.from('club_members').delete().eq('club_id', club_id).eq('user_id', user_id)
      await clearClubIdIfPointing(supabaseAdmin, user_id, club_id)
      return json({ data: { removed: true } }, 200, req)
    }

    if (action === 'set-role') {
      if (me.role !== 'owner') return json({ error: 'Tylko właściciel zmienia role.' }, 403, req)
      if (!['admin', 'member'].includes(role)) return json({ error: 'Nieprawidłowa rola.' }, 400, req)
      await supabaseAdmin.from('club_members').update({ role }).eq('club_id', club_id).eq('user_id', user_id)
      return json({ data: { role } }, 200, req)
    }

    return json({ error: 'Nieznana akcja.' }, 400, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
