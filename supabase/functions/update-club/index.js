import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { normalizeClubName } from '../_shared/clubText.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// Caller must be owner/admin (active) of the club
async function requireManager(supabaseAdmin, clubId, userId) {
  const { data } = await supabaseAdmin.from('club_members')
    .select('role').eq('club_id', clubId).eq('user_id', userId).eq('status', 'active').maybeSingle()
  return data && (data.role === 'owner' || data.role === 'admin')
}

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try {
    const { club_id, name, description, is_public, city, voivodeship, slug } = await req.json()
    if (!club_id) return json({ error: 'club_id required' }, 400, req)

    if (!(await requireManager(supabaseAdmin, club_id, session.userId))) {
      return json({ error: 'Brak uprawnień.' }, 403, req)
    }

    const { data: current, error: currentErr } = await supabaseAdmin
      .from('clubs').select('id, name, slug').eq('id', club_id).single()
    if (currentErr) throw currentErr

    const updates = {}

    if (name !== undefined) {
      const trimmed = (name ?? '').trim()
      if (trimmed.length < 2 || trimmed.length > 120) {
        return json({ error: 'Nazwa klubu jest wymagana (2–120 znaków).' }, 400, req)
      }
      if (trimmed !== current.name) {
        const normalized = normalizeClubName(trimmed)
        const { data: dupe } = await supabaseAdmin
          .from('clubs').select('id').eq('normalized_name', normalized).neq('id', club_id).maybeSingle()
        if (dupe) return json({ error: 'Klub o tej nazwie już istnieje.' }, 409, req)

        updates.name = trimmed
        updates.normalized_name = normalized
      }
    }

    // Renaming a club's address is not supported for now — the same call as for
    // usernames. The slug is the club's identity: changing it repoints every
    // published link, permanently parks the old address in club_slug_history so
    // nobody else can ever take it, and leaves the generated pages stale until
    // someone re-runs the publish script. Whoever needs a different address
    // writes in and it is done by hand.
    //
    // The machinery stays: club_slug_history keeps resolving the one rename
    // that already happened, and create-club still mints the initial slug.
    if (slug !== undefined && String(slug ?? '').trim() !== current.slug) {
      return json({ error: 'Adresu klubu nie można zmienić. Napisz do nas, jeśli potrzebujesz zmiany.' }, 409, req)
    }

    if (description !== undefined) updates.description = description
    if (is_public !== undefined) updates.is_public = is_public
    if (city !== undefined) updates.city = city
    if (voivodeship !== undefined) updates.voivodeship = voivodeship

    if (Object.keys(updates).length === 0) {
      const { data: club, error: clubErr } = await supabaseAdmin
        .from('clubs')
        .select('id, name, slug, description, city, voivodeship, logo_url, is_public, owner_id, created_at')
        .eq('id', club_id).single()
      if (clubErr) throw clubErr
      return json({ data: { club } }, 200, req)
    }

    const { data: club, error: updateErr } = await supabaseAdmin
      .from('clubs')
      .update(updates)
      .eq('id', club_id)
      .select('id, name, slug, description, city, voivodeship, logo_url, is_public, owner_id, created_at')
      .single()
    if (updateErr) {
      if (updateErr.code === '23505') {
        const slugConflict = /slug/i.test(updateErr.message || '')
        return json({ error: slugConflict ? 'Ten slug jest już zajęty.' : 'Klub o tej nazwie już istnieje.' }, 409, req)
      }
      throw updateErr
    }

    return json({ data: { club } }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
