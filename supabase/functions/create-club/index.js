import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { slugifyClub, normalizeClubName } from '../_shared/clubText.js'
import { checkAndAwardBadges } from '../_shared/badge-check.js'
import { logMembershipEvent } from '../_shared/membershipLog.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

async function uniqueSlug(supabaseAdmin, base) {
  let slug = base || 'klub'
  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? slug : `${slug}-${n}`
    const { data } = await supabaseAdmin.from('clubs').select('id').eq('slug', candidate).maybeSingle()
    if (!data) return candidate
  }
  return `${slug}-${crypto.randomUUID().slice(0, 6)}`
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
    const { name, description = null, city = null, voivodeship = null, hidden_public = false } = await req.json()
    const trimmed = (name ?? '').trim()
    if (trimmed.length < 2 || trimmed.length > 120) {
      return json({ error: 'Nazwa klubu jest wymagana (2–120 znaków).' }, 400, req)
    }

    // One active membership per user
    const { data: existing } = await supabaseAdmin
      .from('club_members')
      .select('club_id').eq('user_id', session.userId).eq('status', 'active').maybeSingle()
    if (existing) return json({ error: 'Należysz już do klubu. Opuść go, aby utworzyć nowy.' }, 409, req)

    const normalized = normalizeClubName(trimmed)
    const { data: dupe } = await supabaseAdmin
      .from('clubs').select('id').eq('normalized_name', normalized).maybeSingle()
    if (dupe) return json({ error: 'Klub o tej nazwie już istnieje.' }, 409, req)

    const slug = await uniqueSlug(supabaseAdmin, slugifyClub(trimmed))

    const { data: club, error: clubErr } = await supabaseAdmin
      .from('clubs')
      .insert({
        name: trimmed, normalized_name: normalized, slug,
        owner_id: session.userId, description, city, voivodeship,
      })
      .select('id, name, slug, description, city, voivodeship, owner_id, is_public, created_at')
      .single()
    if (clubErr) {
      if (clubErr.code === '23505') return json({ error: 'Klub o tej nazwie już istnieje.' }, 409, req)
      throw clubErr
    }

    const { error: memErr } = await supabaseAdmin.from('club_members').insert({
      club_id: club.id, user_id: session.userId, role: 'owner', status: 'active',
      joined_at: new Date().toISOString(), hidden_public: !!hidden_public,
    })
    if (memErr) throw memErr

    await supabaseAdmin.from('profiles').update({ club_id: club.id }).eq('id', session.userId)

    await logMembershipEvent(supabaseAdmin, {
      club_id: club.id, user_id: session.userId, event: 'joined', role: 'owner', actor_id: session.userId,
    })

    // Award the club_set badge now that the owner has a club (best-effort).
    await checkAndAwardBadges(supabaseAdmin, session.userId)

    return json({ data: { club } }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
