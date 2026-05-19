import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkAndAwardBadges } from '../_shared/badge-check.js'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Authorization required' }, 401)

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) return json({ error: 'Invalid token' }, 401)

    const body = await req.json()
    const { username, display_name, club, avatar_url, bio, privacy_settings } = body

    if (username !== undefined) {
      if (!/^[a-z0-9_]{3,30}$/.test(username)) {
        return json({ error: 'Username must be 3–30 chars: lowercase letters, numbers, underscores only' }, 400)
      }
      const { data: taken } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('username', username)
        .neq('id', user.id)
        .single()
      if (taken) return json({ error: 'Username already taken' }, 409)
    }

    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, club')
      .eq('id', user.id)
      .single()

    const updates = {}
    if (username !== undefined)         updates.username = username
    if (display_name !== undefined)     updates.display_name = display_name
    if (club !== undefined)             updates.club = club
    if (avatar_url !== undefined)       updates.avatar_url = avatar_url
    if (bio !== undefined)              updates.bio = bio
    if (privacy_settings !== undefined) updates.privacy_settings = privacy_settings

    let profile
    if (!existingProfile) {
      if (!username) return json({ error: 'Username is required for new profiles' }, 400)
      const { data, error } = await supabaseAdmin
        .from('profiles')
        .insert({ id: user.id, ...updates })
        .select()
        .single()
      if (error) throw error
      profile = data
    } else {
      const { data, error } = await supabaseAdmin
        .from('profiles')
        .update(updates)
        .eq('id', user.id)
        .select()
        .single()
      if (error) throw error
      profile = data
    }

    const clubJustSet = club && !existingProfile?.club
    if (clubJustSet || !existingProfile) {
      await checkAndAwardBadges(supabaseAdmin, user.id)
    }

    return json({ data: profile })
  } catch (err) {
    return json({ error: err.message }, 500)
  }
})
