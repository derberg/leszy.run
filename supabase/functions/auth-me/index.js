// supabase/functions/auth-me/index.js
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
  if (!session) return json({ user: null }, 401, req)

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, email, username, display_name, club_id, clubs(name), gender, phone, date_of_birth, city, voivodeship')
    .eq('id', session.userId)
    .single()

  if (!profile) return json({ error: 'Profile not found' }, 404, req)

  const user = { ...profile, club: profile.clubs?.name ?? null }
  delete user.clubs

  return json({ user }, 200, req)
})
