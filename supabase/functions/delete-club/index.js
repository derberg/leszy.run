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
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try {
    const { club_id } = await req.json()
    if (!club_id) return json({ error: 'club_id required' }, 400, req)

    const { data: club, error: clubErr } = await supabaseAdmin
      .from('clubs').select('owner_id').eq('id', club_id).single()
    if (clubErr) throw clubErr
    if (!club || club.owner_id !== session.userId) {
      return json({ error: 'Brak uprawnień.' }, 403, req)
    }

    // FKs cascade: club_members/club_invites ON DELETE CASCADE; profiles.club_id
    // is ON DELETE SET NULL, so members' club_id clears automatically.
    const { error: deleteErr } = await supabaseAdmin.from('clubs').delete().eq('id', club_id)
    if (deleteErr) throw deleteErr

    return json({ data: { deleted: true } }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
