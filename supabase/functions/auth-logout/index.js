// supabase/functions/auth-logout/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'

function json(body, status, req, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...extraHeaders },
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

  const cookieHeader = req.headers.get('Cookie') ?? ''
  const match = cookieHeader.match(/(?:^|;\s*)leszy_session=([^;]+)/)
  if (match) {
    const token = decodeURIComponent(match[1])
    await supabaseAdmin.from('auth_sessions').delete().eq('id', token)
  }

  const clearCookie = 'leszy_session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0'
  return json({ success: true }, 200, req, { 'Set-Cookie': clearCookie })
})
