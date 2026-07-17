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

    const { data: club } = await supabaseAdmin.from('clubs').select('id').eq('id', club_id).maybeSingle()
    if (!club) return json({ error: 'Klub nie istnieje.' }, 404, req)

    // Block if the caller already has an ACTIVE membership anywhere
    const { data: active } = await supabaseAdmin.from('club_members')
      .select('club_id').eq('user_id', session.userId).eq('status', 'active').maybeSingle()
    if (active) return json({ error: 'Należysz już do klubu.' }, 409, req)

    // Idempotent upsert of the pending row (PK = club_id,user_id)
    const { error } = await supabaseAdmin.from('club_members')
      .upsert(
        { club_id, user_id: session.userId, role: 'member', status: 'pending' },
        { onConflict: 'club_id,user_id', ignoreDuplicates: false }
      )
    if (error) throw error

    return json({ data: { status: 'pending' } }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
