import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { slugifyClub, normalizeClubName } from '../_shared/clubText.js'

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

    if (slug !== undefined) {
      const wanted = String(slug ?? '').trim()
      const cleaned = slugifyClub(wanted)
      if (cleaned !== wanted || cleaned.length < 3 || cleaned.length > 80) {
        return json({ error: 'Slug: 3–80 znaków, tylko małe litery ASCII, cyfry i myślniki.' }, 400, req)
      }
      if (cleaned !== current.slug) {
        const { data: taken } = await supabaseAdmin
          .from('clubs').select('id').eq('slug', cleaned).neq('id', club_id).maybeSingle()
        if (taken) return json({ error: 'Ten slug jest już zajęty.' }, 409, req)

        const { data: hist } = await supabaseAdmin
          .from('club_slug_history').select('club_id').eq('old_slug', cleaned).maybeSingle()
        if (hist && hist.club_id !== club_id) {
          return json({ error: 'Ten slug jest już zajęty.' }, 409, req)
        }
        // Reclaiming our own former slug — drop the history row so it doesn't
        // point back at itself.
        if (hist && hist.club_id === club_id) {
          await supabaseAdmin.from('club_slug_history').delete().eq('old_slug', cleaned)
        }
        // Record the outgoing slug so /klub/<old> keeps resolving.
        await supabaseAdmin.from('club_slug_history')
          .upsert({ old_slug: current.slug, club_id }, { onConflict: 'old_slug' })
        updates.slug = cleaned
      }
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
      if (updateErr.code === '23505') return json({ error: 'Klub o tej nazwie już istnieje.' }, 409, req)
      throw updateErr
    }

    return json({ data: { club } }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
