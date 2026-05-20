import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`

export const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const SUPABASE_DOMAIN = new URL(SUPABASE_URL).hostname // 'kojoxazlnxncrpxmnxiq.supabase.co'

/**
 * Creates a profile + session in DB. Returns helpers for Playwright.
 * Call injectSession(context) to authenticate a browser context.
 */
export async function createTestUser(suffix = 'e2e') {
  const email = `e2e-${suffix}-${Date.now()}@test.leszy.run`
  const userId = crypto.randomUUID()

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .insert({ id: userId, email })
  if (profileError) throw profileError

  const sessionToken = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
  const { error: sessionError } = await supabaseAdmin
    .from('auth_sessions')
    .insert({ id: sessionToken, user_id: userId, email, expires_at: expiresAt })
  if (sessionError) throw sessionError

  return {
    user: { id: userId, email },
    email,
    sessionToken,
    /** Call this with a Playwright BrowserContext to inject the session cookie. */
    async injectSession(context) {
      await context.addCookies([{
        name: 'leszy_session',
        value: sessionToken,
        domain: SUPABASE_DOMAIN,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      }])
    },
  }
}

export async function cleanupUser(userId) {
  await supabaseAdmin.from('auth_sessions').delete().eq('user_id', userId)
  await supabaseAdmin.from('profiles').delete().eq('id', userId)
}
