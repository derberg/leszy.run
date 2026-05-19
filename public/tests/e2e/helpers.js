import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`

export const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/**
 * Creates a test user with password auth and returns their magic link URL.
 * The magic link is used in Playwright to navigate directly (no real email needed).
 * The accessToken is also returned for direct Edge Function calls in test helpers.
 */
export async function createTestUser(suffix = 'e2e') {
  const email = `e2e-${suffix}-${Date.now()}@test.leszy.run`
  const password = 'TestE2EPass!99'

  const { data: { user }, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) throw error

  // Generate magic link URL for Playwright to navigate to (bypasses email).
  // redirectTo points to /login so Login.jsx is mounted and can handle the post-auth redirect
  // to /onboarding or /profil based on whether a profile exists.
  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: 'http://localhost:5173/login' },
  })
  if (linkError) throw linkError

  // Also get access token for direct API calls in tests
  const anonClient = createClient(SUPABASE_URL, ANON_KEY)
  const { data: { session } } = await anonClient.auth.signInWithPassword({ email, password })

  return {
    user,
    email,
    password,
    accessToken: session?.access_token ?? null,
    magicLinkUrl: linkData.properties.action_link,
  }
}

export async function cleanupUser(userId) {
  await supabaseAdmin.from('profiles').delete().eq('id', userId)
  await supabaseAdmin.auth.admin.deleteUser(userId)
}
