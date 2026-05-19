import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`

export const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/**
 * Creates a test user and returns a real Supabase session JWT.
 * Uses password auth (test-only — real users use magic link).
 */
export async function createTestSession(suffix = 'user') {
  const email = `test-${suffix}-${Date.now()}@test.leszy.run`
  const password = 'TestPass!99zz'

  const { data: { user }, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) throw error

  const anonClient = createClient(SUPABASE_URL, ANON_KEY)
  const { data: { session }, error: signInError } = await anonClient.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError

  return { user, session, accessToken: session.access_token, email }
}

/** Deletes test user and their profile (cascades). */
export async function cleanupUser(userId) {
  await supabaseAdmin.auth.admin.deleteUser(userId)
}

/** POST to an edge function, returns { status, data }. */
export async function callFunction(name, body, accessToken = null) {
  const headers = { 'Content-Type': 'application/json' }
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
