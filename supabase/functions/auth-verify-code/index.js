import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { verifyCodeAndOpenSession } from '../_shared/verifyCode.js'

function json(body, status, req, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...extraHeaders },
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

  try {
    const { email, code } = await req.json()

    // The whole login step lives in _shared/verifyCode.js, so a registration
    // form that logs someone in on the way answers exactly as this page does.
    const result = await verifyCodeAndOpenSession(supabaseAdmin, { email, code })

    if (!result.ok) {
      const body = result.code ? { error: result.error, code: result.code } : { error: result.error }
      const headers = result.retryAfterSec != null ? { 'retry-after': String(result.retryAfterSec) } : {}
      return json(body, result.status, req, headers)
    }

    return json(
      { success: true, hasUsername: Boolean(result.profile.username) },
      200,
      req,
      { 'Set-Cookie': result.cookie }
    )
  } catch (err) {
    console.error(err)
    return json({ error: 'Błąd serwera.' }, 500, req)
  }
})
