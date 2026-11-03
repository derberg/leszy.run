/**
 * The leszy_session token in a Cookie header, or null. A malformed value
 * (`leszy_session=%E0`) made decodeURIComponent throw, and every function that
 * reads the session answered 500 to it instead of treating it as logged out.
 *
 * @param {string|null|undefined} cookieHeader
 * @returns {string|null}
 */
export function sessionTokenFrom(cookieHeader) {
  const match = (cookieHeader ?? '').match(/(?:^|;\s*)leszy_session=([^;]+)/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]) || null
  } catch {
    return null
  }
}

/**
 * Reads the leszy_session cookie, validates it against auth_sessions.
 * Returns { userId, email } if valid, null otherwise.
 *
 * @param {Request} req
 * @param {ReturnType<import('https://esm.sh/@supabase/supabase-js@2').createClient>} supabaseAdmin
 */
export async function getSession(req, supabaseAdmin) {
  const token = sessionTokenFrom(req.headers.get('Cookie'))
  if (!token) return null

  const { data } = await supabaseAdmin
    .from('auth_sessions')
    .select('user_id, email, expires_at')
    .eq('id', token)
    .single()

  if (!data) return null
  if (new Date(data.expires_at) < new Date()) return null

  return { userId: data.user_id, email: data.email }
}
