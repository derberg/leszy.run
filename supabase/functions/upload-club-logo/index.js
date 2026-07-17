import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// imagescript version pin: 1.2.15 is the known-good tag at time of writing.
// If a deploy fails to fetch it, bump to the latest known-good tag and record
// the working version here. decode → resize(max 512) → encodeWEBP is the
// contract this function relies on; keep that flow if the API differs slightly.
import { Image } from 'https://deno.land/x/imagescript@1.2.15/mod.ts'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

const MAX_BYTES = 5 * 1024 * 1024 // 5MB
const MAX_DIMENSION = 512
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,/

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
    const { club_id, data_url } = await req.json()
    if (!club_id || !data_url) {
      return json({ error: 'club_id, data_url required' }, 400, req)
    }
    if (!(await requireManager(supabaseAdmin, club_id, session.userId))) {
      return json({ error: 'Brak uprawnień.' }, 403, req)
    }

    const match = data_url.match(DATA_URL_RE)
    if (!match) {
      return json({ error: 'Dozwolone: PNG, JPG, WebP.' }, 400, req)
    }

    const base64 = data_url.slice(match[0].length)
    let bytes
    try {
      bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    } catch {
      return json({ error: 'Nieprawidłowe dane obrazu.' }, 400, req)
    }
    if (bytes.length > MAX_BYTES) {
      return json({ error: 'Plik jest za duży (limit 5MB).' }, 400, req)
    }

    const img = await Image.decode(bytes)
    const resized = (img.width > MAX_DIMENSION || img.height > MAX_DIMENSION)
      ? img.resize(
          img.width >= img.height ? MAX_DIMENSION : Image.RESIZE_AUTO,
          img.height > img.width ? MAX_DIMENSION : Image.RESIZE_AUTO
        )
      : img
    // imagescript can decode many formats but only ENCODES PNG — encodeWEBP()
    // does not exist and throws. Store the (optionally downscaled) logo as PNG.
    const png = await resized.encode()

    const path = `${club_id}/logo.png`
    const { error: uploadErr } = await supabaseAdmin.storage
      .from('club-logos')
      .upload(path, png, { contentType: 'image/png', upsert: true })
    if (uploadErr) throw uploadErr

    const { data: pub } = supabaseAdmin.storage.from('club-logos').getPublicUrl(path)
    const logo_url = pub.publicUrl

    const { error: updateErr } = await supabaseAdmin.from('clubs')
      .update({ logo_url }).eq('id', club_id)
    if (updateErr) throw updateErr

    return json({ data: { logo_url } }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
