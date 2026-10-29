import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest, isAllowed } from '../_shared/cors.js'
import { requestLoginCode } from '../_shared/requestCode.js'
import { clientIp } from '../_shared/clientIp.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// Pick the base URL for the magic link from the request Origin, using the SAME
// allowlist guardRequest enforces — a second copy drifted once already: it knew
// about :5173 and not :3002, so a login started on the port the README
// documents mailed a link into PRODUCTION. Falls back to www.leszy.run.
function magicLinkBase(req) {
  const origin = req.headers.get('Origin') ?? ''
  return isAllowed(origin) ? origin : 'https://www.leszy.run'
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
      email, ip: clientIp(req), linkBase: magicLinkBase(req), from: safeFrom,
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
