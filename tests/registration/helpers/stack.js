// Helpers for the LOCAL Supabase stack (`supabase start`). Never production.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { lastCodeFor } from './emailCapture.js'
import { REPO_ROOT, slotWorkdir } from './slot.js'

let cached
export function localEnv() {
  if (cached) return cached
  // REG_TEST_SLOT picks the stack: slot 0 is the repo's own, slot n the one
  // scripts/test-slot.sh made in .supabase-slots/<n>.
  const workdir = slotWorkdir()
  const args = ['status', '-o', 'env', ...(workdir ? ['--workdir', workdir] : [])]
  const out = execFileSync('supabase', args, { encoding: 'utf8', cwd: REPO_ROOT })
  const env = {}
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Z_]+)="?(.*?)"?$/)
    if (m) env[m[1]] = m[2]
  }
  const url = env.API_URL
  if (!url || !url.startsWith('http://127.0.0.1')) {
    throw new Error(`Refusing to run: API_URL is "${url}", not the local stack (http://127.0.0.1...)`)
  }
  const dbUrl = env.DB_URL
  if (!dbUrl || !/^postgres(ql)?:\/\/[^@]+@127\.0\.0\.1:/.test(dbUrl)) {
    throw new Error(`Refusing to run: DB_URL is not the local stack (127.0.0.1)`)
  }
  cached = { url, dbUrl, anonKey: env.ANON_KEY, serviceKey: env.SERVICE_ROLE_KEY, jwtSecret: env.JWT_SECRET, functionsUrl: `${url}/functions/v1` }
  return cached
}

let client
export function admin() {
  if (!client) {
    const { url, serviceKey } = localEnv()
    client = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  }
  return client
}

/** Profile (created if missing) + auth_sessions row, no email round trip. */
export async function sessionFor(email) {
  const db = admin()
  const normalized = email.toLowerCase().trim()
  let { data: profile } = await db.from('profiles').select('id').eq('email', normalized).maybeSingle()
  if (!profile) {
    const { data, error } = await db.from('profiles').insert({ id: crypto.randomUUID(), email: normalized }).select('id').single()
    if (error) throw error
    profile = data
  }
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
  const { error } = await db.from('auth_sessions').insert({ id: token, user_id: profile.id, email: normalized, expires_at: expiresAt })
  if (error) throw error
  return { cookie: `leszy_session=${token}`, token, profileId: profile.id }
}

/** Real login: auth-request-code -> captured email -> auth-verify-code. Returns "leszy_session=...". */
export async function loginViaEmail(email) {
  const { functionsUrl } = localEnv()
  const post = (fn, body) => fetch(`${functionsUrl}/${fn}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const r1 = await post('auth-request-code', { email })
  if (!r1.ok) throw new Error(`auth-request-code ${r1.status}: ${await r1.text()}`)
  let code = null
  for (let i = 0; i < 20 && !code; i++) {
    code = await lastCodeFor(email)
    if (!code) await new Promise((r) => setTimeout(r, 250))
  }
  if (!code) throw new Error('no login email captured (is the capture server up and EMAIL_CAPTURE_URL set for functions?)')
  const r2 = await post('auth-verify-code', { email, code })
  if (!r2.ok) throw new Error(`auth-verify-code ${r2.status}: ${await r2.text()}`)
  const setCookie = r2.headers.get('set-cookie') || ''
  const m = setCookie.match(/leszy_session=[^;]+/)
  if (!m) throw new Error('no leszy_session cookie in auth-verify-code response')
  return m[0]
}

/** Local only: clears the login throttle so repeated logins in one run never 429. */
export async function resetThrottle() {
  localEnv()
  const { error } = await admin().from('otp_throttle').delete().neq('key', '')
  if (error) throw error
}

/** A PostgREST client acting as the `authenticated` role (HS256 JWT signed with the local JWT secret). */
export function authenticatedClient() {
  const { url, anonKey, jwtSecret } = localEnv()
  if (!jwtSecret) throw new Error('supabase status printed no JWT_SECRET')
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'authenticated', sub: crypto.randomUUID(), iat: now, exp: now + 600 })}`
  const sig = crypto.createHmac('sha256', jwtSecret).update(unsigned).digest('base64url')
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${unsigned}.${sig}` } },
  })
}
