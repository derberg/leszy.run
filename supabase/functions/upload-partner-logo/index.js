import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// imagescript 1.2.15, as in upload-club-logo: decode → resize → encode(), which writes PNG only
// (encodeWEBP does not exist). It decodes PNG and JPEG but has NO WebP decoder (no version up to
// 1.3.0 has one), so a real WebP passes the header checks and is then refused as unreadable.
import { Image } from 'https://deno.land/x/imagescript@1.2.15/mod.ts'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { partnerOf } from '../_shared/registration/partners.js'
import { imageHeader } from '../_shared/imageHeader.js'

// POST { eventId, partnerId, dataUrl } → 200 { data: { logoUrl } }: the partner's logo, re-encoded.
// POST { eventId, partnerId, remove: true } → 200 { data: { logoUrl: null } }.
// The club's owner or an admin only (a member, an outsider, a disabled club and another event's
// partner get 404, as in organizer-partners). Session only: the admin app's backend processes its
// logos itself. Not behind PAID_REGISTRATION_ENABLED: a logo moves no money.
//
// The input is never served as sent. In order, before anything decodes it: the data URL must say
// PNG, JPEG or WebP; at most 2 MB once decoded; the magic bytes must be one of those three (the
// data URL's MIME type is not trusted); the header's width and height at most 6000 each. Only then
// imagescript decodes it, fits it inside 400×400 (never enlarged) and writes a PNG to
// partner-logos/<uuid>.png. The row points at the new object before the old one is removed; a
// row that cannot be updated takes its new object with it. A legacy row (logo_url, no logo_path:
// an old SVG the admin app stored) never has its object touched here.

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

const NOT_FOUND = { error: 'Not found' }
const MANAGERS = ['owner', 'admin']
const BUCKET = 'partner-logos'
const MAX_BYTES = 2 * 1024 * 1024
const MAX_HEADER_PX = 6000
const MAX_OUTPUT_PX = 400
const TYPES = ['png', 'jpeg', 'webp']
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,/

const REFUSALS = {
  invalid_type: [400, 'Dozwolone: PNG, JPG, WebP.'],
  too_big: [400, 'Plik jest za duży (limit 2 MB).'],
  too_large: [400, 'Obraz jest za duży (maks. 6000×6000 px).'],
  unreadable: [400, 'Nie udało się odczytać obrazu.'],
  invalid_request: [400, 'Wyślij logo albo remove: true.'],
  logo_changed: [409, 'Logo właśnie się zmieniło — spróbuj ponownie.'],
}

const refuse = (req, code) => {
  const [status, error] = REFUSALS[code]
  return json({ error, code }, status, req)
}

/** The data URL's bytes, refused on everything that can be told before decoding. */
function readImage(dataUrl) {
  if (typeof dataUrl !== 'string') return { refusal: 'invalid_type' }
  const match = dataUrl.match(DATA_URL_RE)
  if (!match) return { refusal: 'invalid_type' }
  const base64 = dataUrl.slice(match[0].length)
  // A cheap bound before atob: 4 base64 characters per 3 bytes.
  if (base64.length > Math.ceil(MAX_BYTES / 3) * 4 + 4) return { refusal: 'too_big' }
  let bytes
  try {
    bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  } catch {
    return { refusal: 'invalid_type' }
  }
  if (bytes.length > MAX_BYTES) return { refusal: 'too_big' }
  const header = imageHeader(bytes)
  if (!header || !TYPES.includes(header.type)) return { refusal: 'invalid_type' }
  if (header.width > MAX_HEADER_PX || header.height > MAX_HEADER_PX) return { refusal: 'too_large' }
  return { bytes }
}

/** Decoded, fitted inside 400×400 (never enlarged), encoded as PNG; null when it does not decode. */
async function reencode(bytes) {
  let img
  try {
    img = await Image.decode(bytes)
  } catch {
    return null
  }
  if (img.width > MAX_OUTPUT_PX || img.height > MAX_OUTPUT_PX) {
    img = img.width >= img.height
      ? img.resize(MAX_OUTPUT_PX, Image.RESIZE_AUTO)
      : img.resize(Image.RESIZE_AUTO, MAX_OUTPUT_PX)
  }
  return await img.encode()
}

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const session = await getSession(req, admin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid JSON' }, 400, req)

  try {
    // write: false, then the role: a member gets the outsider's 404, as in organizer-partners.
    const loaded = await loadOrganizerEvent(admin, body.eventId, session, { write: false, req })
    if (loaded instanceof Response) return loaded
    if (!MANAGERS.includes(loaded.role)) return json(NOT_FOUND, 404, req)
    const { settings } = loaded
    const eventId = settings.event_id
    const partner = await partnerOf(admin, eventId, body.partnerId)
    if (!partner) return json(NOT_FOUND, 404, req)

    const remove = body.remove === true
    if (!remove && !('dataUrl' in body)) return refuse(req, 'invalid_request')

    let path = null
    let logoUrl = null
    if (!remove) {
      const { bytes, refusal } = readImage(body.dataUrl)
      if (refusal) return refuse(req, refusal)
      const png = await reencode(bytes)
      if (!png) return refuse(req, 'unreadable')
      path = `${crypto.randomUUID()}.png`
      const { error: upErr } = await admin.storage.from(BUCKET).upload(path, png, { contentType: 'image/png', upsert: false })
      if (upErr) throw upErr
      logoUrl = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
    }

    // Conditional on the logo_path read above: of two uploads at once, the second finds the row
    // changed and takes its own object back, so no object is left that no row points at.
    let update = admin.from('event_partners')
      .update({ logo_url: logoUrl, logo_path: path, updated_at: new Date().toISOString() })
      .eq('id', partner.id).eq('event_id', eventId)
    update = partner.logo_path ? update.eq('logo_path', partner.logo_path) : update.is('logo_path', null)
    const { data: updated, error: updErr } = await update.select('id')
    if (updErr || !updated?.length) {
      if (path) {
        const { error: rmErr } = await admin.storage.from(BUCKET).remove([path])
        if (rmErr) console.error('upload-partner-logo rollback remove failed:', rmErr.message)
      }
      if (updErr) throw updErr
      return refuse(req, 'logo_changed')
    }

    if (partner.logo_path) {
      const { error: rmErr } = await admin.storage.from(BUCKET).remove([partner.logo_path])
      if (rmErr) console.error('upload-partner-logo old logo remove failed:', rmErr.message)
    }
    await logOrganizerAction(admin, req, {
      actorId: session.userId, clubId: settings.club_id, eventId,
      action: 'partner_logo_changed', target: partner.id, payload: remove ? { removed: true } : null,
    })
    return json({ data: { logoUrl } }, 200, req)
  } catch (err) {
    console.error('upload-partner-logo error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
