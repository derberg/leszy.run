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

export function handleOptions(req) {
  if (req.method !== 'OPTIONS') return null
  return new Response('ok', { headers: getCorsHeaders(req) })
}
