/**
 * Reads the leszy_session cookie, validates it against auth_sessions.
 * Returns { userId, email } if valid, null otherwise.
 *
 * @param {Request} req
 * @param {ReturnType<import('https://esm.sh/@supabase/supabase-js@2').createClient>} supabaseAdmin
 */
export async function getSession(req, supabaseAdmin) {
  const cookieHeader = req.headers.get('Cookie') ?? ''
  const match = cookieHeader.match(/(?:^|;\s*)leszy_session=([^;]+)/)
  if (!match) return null

  const token = decodeURIComponent(match[1])

  const { data } = await supabaseAdmin
    .from('auth_sessions')
    .select('user_id, email, expires_at')
    .eq('id', token)
    .single()

  if (!data) return null
  if (new Date(data.expires_at) < new Date()) return null

  return { userId: data.user_id, email: data.email }
}
