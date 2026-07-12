// supabase/functions/log-consent/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

const VALID_DECISIONS = ['accepted', 'rejected', 'withdrawn']

function json(body, status, req, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...extraHeaders },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, req)
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) {
    return json({ error: 'Unauthorized' }, 401, req)
  }

  let body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400, req)
  }

  const { decision, policyVersion } = body

  if (!decision || !VALID_DECISIONS.includes(decision)) {
    return json({ error: 'Invalid decision. Must be one of: accepted, rejected, withdrawn' }, 400, req)
  }

  if (!policyVersion || typeof policyVersion !== 'string' || policyVersion.trim() === '') {
    return json({ error: 'policyVersion is required and must be a non-empty string' }, 400, req)
  }

  // Extract first hop from x-forwarded-for (may be undefined if not proxied)
  const forwardedFor = req.headers.get('x-forwarded-for') ?? ''
  const ipInet = forwardedFor.split(',')[0].trim() || null

  const userAgent = req.headers.get('user-agent') ?? null

  const { error } = await supabaseAdmin
    .from('consent_log')
    .insert({
      user_id: session.userId,
      decision,
      policy_version: policyVersion,
      ip_inet: ipInet,
      user_agent: userAgent,
    })

  if (error) {
    console.error('consent_log insert error:', error)
    return json({ error: 'Failed to log consent' }, 500, req)
  }

  return json({ logged: true }, 200, req)
})
