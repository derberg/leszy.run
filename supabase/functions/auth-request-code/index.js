import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest, emailLinkBase } from '../_shared/cors.js'
import { requestLoginCode } from '../_shared/requestCode.js'
import { clientIp } from '../_shared/clientIp.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// The magic link carries a live login code, so its host must never be one the
// caller chose: emailLinkBase allows production, and localhost only on a local
// stack. It used to follow isAllowed, whose preview pattern matched any
// *-derbergs-projects.vercel.app host, so a request with such an Origin mailed
// the victim a genuine login link pointing at that host.
function magicLinkBase(req) {
  return emailLinkBase(req.headers.get('Origin'), Deno.env.get('SUPABASE_URL'))
}

// `from` must be an internal path: starts with single "/", no "//", no "\", no "..".
function sanitizeFrom(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  if (!raw.startsWith('/')) return null
  if (raw.startsWith('//') || raw.includes('\\') || raw.includes('..')) return null
  if (raw.length > 500) return null
  return raw
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
    const { email, honeypot, from } = await req.json()
    const safeFrom = sanitizeFrom(from)

    if (honeypot) return json({ success: true }, 200, req)

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Nieprawidłowy adres email.' }, 400, req)
    }

    // The retired-address refusal, the limits, the code and the e-mail: _shared/requestCode.js.
    const result = await requestLoginCode(supabaseAdmin, {
      email, ip: await clientIp(req), linkBase: magicLinkBase(req), from: safeFrom,
    })
    if (!result.ok) {
      const headers = { ...getCorsHeaders(req), 'Content-Type': 'application/json' }
      if (result.retryAfterSec != null) headers['retry-after'] = String(result.retryAfterSec)
      return new Response(JSON.stringify({ error: result.error, ...(result.code ? { code: result.code } : {}) }), {
        status: result.status, headers,
      })
    }

    return json({ success: true }, 200, req)
  } catch (err) {
    console.error(err)
    return json({ error: 'Błąd serwera. Spróbuj ponownie.' }, 500, req)
  }
})
