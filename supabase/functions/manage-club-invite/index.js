import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

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
    const { club_id, op, expires_at, max_uses, invite_id, email, username } = await req.json()
    if (!club_id || !op) {
      return json({ error: 'club_id, op required' }, 400, req)
    }
    if (!(await requireManager(supabaseAdmin, club_id, session.userId))) {
      return json({ error: 'Brak uprawnień.' }, 403, req)
    }

    if (op === 'create-link') {
      const code = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      const { data: invite, error } = await supabaseAdmin.from('club_invites')
        .insert({
          club_id,
          kind: 'link',
          code,
          created_by: session.userId,
          expires_at: expires_at ?? null,
          max_uses: max_uses ?? null,
        })
        .select('id, code, expires_at, max_uses, uses')
        .single()
      if (error) throw error
      return json({ data: { invite } }, 200, req)
    }

    if (op === 'create-direct') {
      if (!email && !username) {
        return json({ error: 'Wymagany email lub nazwa użytkownika.' }, 400, req)
      }
      const { data: invite, error } = await supabaseAdmin.from('club_invites')
        .insert({
          club_id,
          kind: 'direct',
          target_email: email ?? null,
          target_username: username ?? null,
          created_by: session.userId,
        })
        .select('id')
        .single()
      if (error) throw error
      // TODO(notify): send the invite email/notification to the target once the
      // frontend/notify path lands. Row creation is all this endpoint owns.
      return json({ data: { invite } }, 200, req)
    }

    if (op === 'revoke') {
      if (!invite_id) return json({ error: 'invite_id required' }, 400, req)
      const { error } = await supabaseAdmin.from('club_invites')
        .update({ revoked: true }).eq('id', invite_id).eq('club_id', club_id)
      if (error) throw error
      return json({ data: { revoked: true } }, 200, req)
    }

    if (op === 'list') {
      const { data: invites, error } = await supabaseAdmin.from('club_invites')
        .select('id, kind, code, target_email, target_username, expires_at, max_uses, uses, created_by, created_at')
        .eq('club_id', club_id).eq('revoked', false)
        .order('created_at', { ascending: false })
      if (error) throw error
      const now = new Date()
      const active = (invites || []).filter(inv => !inv.expires_at || new Date(inv.expires_at) > now)
      return json({ data: { invites: active } }, 200, req)
    }

    return json({ error: 'Nieznana operacja.' }, 400, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
