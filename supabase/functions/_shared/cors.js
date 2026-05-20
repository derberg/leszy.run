const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://www.leszy.run',
  'https://leszy.run',
]

export function getCorsHeaders(req) {
  const origin = req.headers.get('Origin') ?? ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[1]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Credentials': 'true',
  }
}

export function handleOptions(req) {
  if (req.method !== 'OPTIONS') return null
  return new Response('ok', { headers: getCorsHeaders(req) })
}
