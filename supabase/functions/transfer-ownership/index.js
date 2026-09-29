import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logMembershipEvent } from '../_shared/membershipLog.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

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
    const { club_id, op, user_id } = await req.json()
    if (!club_id || !op) {
      return json({ error: 'club_id, op required' }, 400, req)
    }

    const { data: club, error: clubErr } = await supabaseAdmin.from('clubs')
      .select('id, owner_id, pending_owner_id').eq('id', club_id).maybeSingle()
    if (clubErr) throw clubErr
    if (!club) return json({ error: 'Klub nie istnieje.' }, 404, req)

    if (op === 'nominate') {
      if (club.owner_id !== session.userId) return json({ error: 'Brak uprawnień.' }, 403, req)
      if (!user_id) return json({ error: 'user_id required' }, 400, req)

      const { data: member } = await supabaseAdmin.from('club_members')
        .select('user_id').eq('club_id', club_id).eq('user_id', user_id).eq('status', 'active').maybeSingle()
      if (!member) return json({ error: 'Użytkownik nie jest aktywnym członkiem klubu.' }, 400, req)

      const { error } = await supabaseAdmin.from('clubs')
        .update({ pending_owner_id: user_id }).eq('id', club_id)
      if (error) throw error
      return json({ data: { pending_owner_id: user_id } }, 200, req)
    }

    if (op === 'cancel') {
      if (club.owner_id !== session.userId) return json({ error: 'Brak uprawnień.' }, 403, req)
      const { error } = await supabaseAdmin.from('clubs')
        .update({ pending_owner_id: null }).eq('id', club_id)
      if (error) throw error
      return json({ data: { cancelled: true } }, 200, req)
    }

    if (op === 'accept') {
      if (!club.pending_owner_id || club.pending_owner_id !== session.userId) {
        return json({ error: 'Brak uprawnień.' }, 403, req)
      }

      // The nomination is checked against an ACTIVE membership at accept time,
      // not just at nominate time. Nothing cleared pending_owner_id when the
      // nominee left or was removed, so they could walk out, join another club,
      // and then accept: the club ended up owned by a non-member, its previous
      // owner demoted to admin, and NOBODY able to delete it or change a role.
      const { data: stillMember } = await supabaseAdmin.from('club_members')
        .select('user_id').eq('club_id', club_id).eq('user_id', session.userId)
        .eq('status', 'active').maybeSingle()
      if (!stillMember) {
        await supabaseAdmin.from('clubs').update({ pending_owner_id: null }).eq('id', club_id)
        return json({ error: 'Nie jesteś już członkiem tego klubu.' }, 409, req)
      }

      const previousOwnerId = club.owner_id

      const { error: clubUpdateErr } = await supabaseAdmin.from('clubs')
        .update({ owner_id: session.userId, pending_owner_id: null }).eq('id', club_id)
      if (clubUpdateErr) throw clubUpdateErr

      const { error: newOwnerErr } = await supabaseAdmin.from('club_members')
        .update({ role: 'owner' }).eq('club_id', club_id).eq('user_id', session.userId)
      if (newOwnerErr) throw newOwnerErr

      if (previousOwnerId && previousOwnerId !== session.userId) {
        const { error: oldOwnerErr } = await supabaseAdmin.from('club_members')
          .update({ role: 'admin' }).eq('club_id', club_id).eq('user_id', previousOwnerId)
        if (oldOwnerErr) throw oldOwnerErr
        await logMembershipEvent(supabaseAdmin, {
          club_id, user_id: previousOwnerId, event: 'role_changed', role: 'admin', actor_id: session.userId,
        })
      }

      // A transfer changes two people's roles and used to write nothing to the
      // log, while a hand-made demotion wrote a row — so the history said an
      // owner had simply always been an admin.
      await logMembershipEvent(supabaseAdmin, {
        club_id, user_id: session.userId, event: 'role_changed', role: 'owner', actor_id: session.userId,
      })

      return json({ data: { owner_id: session.userId } }, 200, req)
    }

    if (op === 'decline') {
      if (!club.pending_owner_id || club.pending_owner_id !== session.userId) {
        return json({ error: 'Brak uprawnień.' }, 403, req)
      }
      const { error } = await supabaseAdmin.from('clubs')
        .update({ pending_owner_id: null }).eq('id', club_id)
      if (error) throw error
      return json({ data: { declined: true } }, 200, req)
    }

    return json({ error: 'Nieznana operacja.' }, 400, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
