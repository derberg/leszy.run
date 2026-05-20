const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`

async function callEdge(name, body) {
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `${name} failed`)
  return data
}

export async function requestCode(email, honeypot = '') {
  return callEdge('auth-request-code', { email, honeypot })
}

export async function verifyCode(email, code) {
  return callEdge('auth-verify-code', { email, code })
}

export async function signOut() {
  return callEdge('auth-logout', {})
}

export async function getMe() {
  const res = await fetch(`${FUNCTIONS_BASE}/auth-me`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({}),
  })
  if (!res.ok) return null
  const data = await res.json()
  return data.user ?? null
}

export async function callFunction(name, body) {
  return callEdge(name, body)
}
