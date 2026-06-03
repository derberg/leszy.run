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
    const { username, display_name, club, club_id, avatar_url, bio, privacy_settings } = body

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
      .select('id, club_id')
      .eq('id', session.userId)
      .single()

    const updates = {}
    if (username !== undefined)          updates.username = username
    if (display_name !== undefined)      updates.display_name = display_name
    if (avatar_url !== undefined)        updates.avatar_url = avatar_url
    if (bio !== undefined)               updates.bio = bio
    if (privacy_settings !== undefined)  updates.privacy_settings = privacy_settings

    // Club: either a picked club_id (validate it exists) or free text (find-or-create).
    if (club_id !== undefined && club_id !== null && club_id !== '') {
      const { data: clubRow } = await supabaseAdmin
        .from('clubs').select('id').eq('id', club_id).single()
      if (!clubRow) return json({ error: 'Unknown club_id' }, 400, req)
      updates.club_id = club_id
    } else if (club !== undefined) {
      if (club === null || club.trim() === '') {
        updates.club_id = null
      } else {
        if (club.length > 100) return json({ error: 'Club name too long (max 100 chars)' }, 400, req)
        const { data: newClubId, error: clubErr } = await supabaseAdmin
          .rpc('find_or_create_club', { club_name: club })
        if (clubErr) throw clubErr
        if (!newClubId) return json({ error: 'Invalid club name' }, 400, req)
        updates.club_id = newClubId
      }
    }

    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', session.userId)
      .select('*, clubs(name)')
      .single()
    if (error) throw error

    const clubJustSet = updates.club_id && !existingProfile?.club_id
    if (clubJustSet) {
      await checkAndAwardBadges(supabaseAdmin, session.userId)
    }

    // API contract: keep returning club as a string
    const out = { ...profile, club: profile.clubs?.name ?? null }
    delete out.clubs

    return json({ data: out }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
