const STATIC_ORIGINS = [
  'http://localhost:5173',
  'https://www.leszy.run',
  'https://leszy.run',
]

const PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+-derbergs-projects\.vercel\.app$/

function isAllowed(origin) {
  if (!origin) return false
  if (STATIC_ORIGINS.includes(origin)) return true
  return PREVIEW_ORIGIN_RE.test(origin)
}

export function getCorsHeaders(req) {
  const origin = req.headers.get('Origin') ?? ''
  const allowed = isAllowed(origin) ? origin : STATIC_ORIGINS[1]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }
}

/**
 * First line of every function: answers a preflight, and refuses a request that
 * a page on some other origin made with the user's cookie.
 *
 *   const guard = guardRequest(req)
 *   if (guard) return guard
 *
 * CORS headers alone never stopped this. They govern whether the BROWSER hands
 * the response back to the calling script — the request still runs. A page on
 * evil.example could POST to /edge/delete-club with `credentials: 'include'`
 * and Content-Type text/plain (a CORS-safelisted value, so no preflight fires),
 * the session cookie would ride along, req.json() parses the body regardless of
 * Content-Type, and the club is gone. The attacker never needs to read the
 * reply. Rejecting on Origin is what actually stops it; the SameSite=Lax cookie
 * added alongside this is the other half.
 *
 * A request with NO Origin header passes: browsers always send Origin on
 * cross-origin requests, so its absence means a non-browser caller (the
 * checkpoint agent, a backend script, curl, the test suite) that carries no
 * ambient cookie to abuse.
 */
export function guardRequest(req) {
  const origin = req.headers.get('Origin')
  if (origin && !isAllowed(origin)) {
    return new Response(JSON.stringify({ error: 'Forbidden origin' }), {
      status: 403,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })
  }
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) })
  }
  return null
}
