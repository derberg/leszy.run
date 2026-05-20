import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkAndAwardBadges } from '../_shared/badge-check.js'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try {
    const body = await req.json()
    const { username, display_name, club, avatar_url, bio, privacy_settings } = body

    if (username !== undefined) {
      if (!/^[a-z0-9_]{3,30}$/.test(username)) {
        return json({ error: 'Username must be 3–30 chars: lowercase letters, numbers, underscores only' }, 400, req)
      }
      const { data: taken } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('username', username)
        .neq('id', session.userId)
        .single()
      if (taken) return json({ error: 'Username already taken' }, 409, req)
    }

    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, club')
      .eq('id', session.userId)
      .single()

    const updates = {}
    if (username !== undefined)          updates.username = username
    if (display_name !== undefined)      updates.display_name = display_name
    if (club !== undefined)              updates.club = club
    if (avatar_url !== undefined)        updates.avatar_url = avatar_url
    if (bio !== undefined)               updates.bio = bio
    if (privacy_settings !== undefined)  updates.privacy_settings = privacy_settings

    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', session.userId)
      .select()
      .single()
    if (error) throw error

    const clubJustSet = club && !existingProfile?.club
    if (clubJustSet) {
      await checkAndAwardBadges(supabaseAdmin, session.userId)
    }

    return json({ data: profile }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
