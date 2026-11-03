import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
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
    const { club_id } = await req.json()
    if (!club_id) return json({ error: 'club_id required' }, 400, req)

    const { data: club, error: clubErr } = await supabaseAdmin
      .from('clubs').select('owner_id').eq('id', club_id).single()
    if (clubErr) throw clubErr
    if (!club || club.owner_id !== session.userId) {
      return json({ error: 'Brak uprawnień.' }, 403, req)
    }

    // A club that owns an online-registration event cannot go: the event and
    // its entries are tied to it (registration_settings.club_id is ON DELETE
    // RESTRICT, so the delete below would fail with an opaque FK error).
    const { count, error: regErr } = await supabaseAdmin
      .from('registration_settings').select('event_id', { count: 'exact', head: true }).eq('club_id', club_id)
    if (regErr) throw regErr
    if (count > 0) {
      return json({ error: 'Klub ma wydarzenia z zapisami — nie można go usunąć.' }, 409, req)
    }

    // FKs cascade: club_members/club_invites ON DELETE CASCADE; profiles.club_id
    // is ON DELETE SET NULL, so members' club_id clears automatically.
    const { error: deleteErr } = await supabaseAdmin.from('clubs').delete().eq('id', club_id)
    if (deleteErr) throw deleteErr

    // The logo is stored at club-logos/<club_id>/logo.png (upload-club-logo)
    // in a public bucket, and nothing removed it with the club. Best effort:
    // the club is already gone, so a storage failure is logged, never a 500.
    const { error: logoErr } = await supabaseAdmin.storage.from('club-logos').remove([`${club_id}/logo.png`])
    if (logoErr) console.error('delete-club: logo remove failed:', logoErr.message)

    return json({ data: { deleted: true } }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
