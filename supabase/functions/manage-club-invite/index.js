import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
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

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_LINK_TTL_MS = 30 * DAY_MS
const DEFAULT_DIRECT_TTL_MS = 30 * DAY_MS

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

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
          // Default expiry, because the UI never passed one and a link pasted
          // into a public post otherwise admits strangers a year later. The
          // caller can still choose, and "Unieważnij" still works.
          expires_at: expires_at ?? new Date(Date.now() + DEFAULT_LINK_TTL_MS).toISOString(),
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
      // A direct invite carries a code as well, so the manager has something to
      // send: nothing in this system mails it (there is no notification type
      // for club events), and without a code there was no URL at all — the
      // invitee could only ever find it by chance on /profil/klub. It is bound
      // to the named person in accept-invite, so passing the link on does not
      // let somebody else in, and it is single-use with an expiry.
      const code = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      const { data: invite, error } = await supabaseAdmin.from('club_invites')
        .insert({
          club_id,
          kind: 'direct',
          code,
          target_email: email ?? null,
          target_username: username ?? null,
          created_by: session.userId,
          max_uses: 1,
          expires_at: new Date(Date.now() + DEFAULT_DIRECT_TTL_MS).toISOString(),
        })
        .select('id, code, target_email, target_username, expires_at')
        .single()
      if (error) throw error
      return json({ data: { invite } }, 200, req)
    }

    if (op === 'revoke') {
      if (!invite_id) return json({ error: 'invite_id required' }, 400, req)
      // .select() so "revoked: true" means a row actually changed. Without it a
      // stale id — or one belonging to another club — reported success and the
      // manager believed a live invite was dead.
      const { data: revoked, error } = await supabaseAdmin.from('club_invites')
        .update({ revoked: true }).eq('id', invite_id).eq('club_id', club_id).select('id')
      if (error) throw error
      if (!revoked?.length) return json({ error: 'Nie znaleziono takiego zaproszenia.' }, 404, req)
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
