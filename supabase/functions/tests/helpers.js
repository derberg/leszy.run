import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`

export const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/** Creates an auth user + profile + session in DB. Returns { user, sessionToken, email }. */
export async function createTestSession(suffix = 'test') {
  const email = `test-${suffix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@test.leszy.run`

  // Create a real auth.users row so tables whose user_id FK references auth.users
  // (e.g. consent_log) can be seeded against this session. The profile id matches
  // the auth user id (profiles.id FK → auth.users.id).
  const { data: created, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
  })
  if (authError) throw authError
  const userId = created.user.id

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .insert({ id: userId, email })
  if (profileError) throw profileError

  const sessionToken = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const { error: sessionError } = await supabaseAdmin
    .from('auth_sessions')
    .insert({ id: sessionToken, user_id: userId, email, expires_at: expiresAt })
  if (sessionError) throw sessionError

  return { user: { id: userId, email }, sessionToken, email }
}

/** Deletes session(s), profile, and the auth user. */
export async function cleanupUser(userId) {
  await supabaseAdmin.from('auth_sessions').delete().eq('user_id', userId)
  await supabaseAdmin.from('profiles').delete().eq('id', userId)
  // Best-effort: remove the auth.users row created in createTestSession.
  try { await supabaseAdmin.auth.admin.deleteUser(userId) } catch { /* ignore */ }
}

/** POST to an edge function. Pass sessionToken to send as cookie. */
export async function callFunction(name, body, sessionToken = null) {
  const headers = { 'Content-Type': 'application/json' }
  if (sessionToken) headers['Cookie'] = `leszy_session=${sessionToken}`
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
