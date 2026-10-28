import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// Same pin as upload-club-logo. It decodes PNG and JPEG (not WebP: the
// browser's resizePoster turns every poster into a JPEG first) and its
// encoders write pixels only, which is what strips EXIF.
import { Image } from 'https://deno.land/x/imagescript@1.2.15/mod.ts'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { parseGpx, GpxError } from '../_shared/registration/gpx.js'

// POST upload-registration-file (owner or admin of the event's club)
//   poster:          { eventId, kind: 'poster', dataUrl, fileName }            → 201 { data: { uploadId, url, meta } }
//   regulamin, gpx:  { eventId, kind, fileName, action: 'start' }               → 200 { data: { pendingPath, signedUrl, token } }
//                    the browser PUTs the file to the PRIVATE registration-pending bucket, then
//                    { eventId, kind, pendingPath, action: 'finish' }           → 201 { data: { uploadId, url, meta } }
// A PDF or GPX is too big for a base64 JSON body through the /edge rewrite,
// hence the two steps. Only a validated file reaches the public
// registration-files bucket (<eventId>/<kind>/<uuid>.<ext>); finish deletes
// the pending object whatever the outcome.

const PENDING = 'registration-pending'
const FILES = 'registration-files'

const MB = 1024 * 1024
const POSTER_MAX_BYTES = 5 * MB
const POSTER_MIN_WIDTH = 1200
const POSTER_MAX_WIDTH = 1600
const POSTER_JPEG_QUALITY = 85
const REGULAMIN_MAX_BYTES = 10 * MB
const GPX_MAX_BYTES = 5 * MB

const INVALID = 'Nieprawidłowe dane.'
const POSTER_TYPE = 'Plakat musi być plikiem JPG lub PNG.'
const POSTER_TOO_BIG = 'Plakat może mieć najwyżej 5 MB.'
const POSTER_WIDTH = 'Plakat musi mieć co najmniej 1200 px szerokości.'
const REGULAMIN_BAD = 'Regulamin musi być plikiem PDF do 10 MB.'
const GPX_TOO_BIG = 'Plik GPX może mieć najwyżej 5 MB.'

const DATA_URL_RE = /^data:image\/(png|jpe?g);base64,/
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-

// What a regulamin or GPX must pass at finish. `tooBig` doubles as the answer
// for a pending object that is missing: for an honest client that only
// happens when Storage refused the PUT over the bucket's size limit.
const TWO_STEP = {
  regulamin: { maxBytes: REGULAMIN_MAX_BYTES, tooBig: REGULAMIN_BAD, ext: 'pdf', contentType: 'application/pdf' },
  gpx: { maxBytes: GPX_MAX_BYTES, tooBig: GPX_TOO_BIG, ext: 'gpx', contentType: 'application/gpx+xml' },
}

class Rejected extends Error {}

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

const cleanFileName = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '') || null

async function poster(dataUrl) {
  const match = typeof dataUrl === 'string' ? dataUrl.match(DATA_URL_RE) : null
  if (!match) throw new Rejected(POSTER_TYPE)
  const base64 = dataUrl.slice(match[0].length)
  // Checked before decoding so an oversized body never becomes a buffer.
  if (base64.length > Math.ceil(POSTER_MAX_BYTES / 3) * 4) throw new Rejected(POSTER_TOO_BIG)
  let img
  try {
    img = await Image.decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))
  } catch {
    throw new Rejected(POSTER_TYPE)
  }
  if (img.width < POSTER_MIN_WIDTH) throw new Rejected(POSTER_WIDTH)
  // resizePoster already caps the width; a client that skipped it is scaled here.
  if (img.width > POSTER_MAX_WIDTH) {
    img = img.resize(POSTER_MAX_WIDTH, Math.round((img.height * POSTER_MAX_WIDTH) / img.width))
  }
  const bytes = await img.encodeJPEG(POSTER_JPEG_QUALITY)
  return { bytes, ext: 'jpg', contentType: 'image/jpeg', meta: { width: img.width, height: img.height } }
}

function checkTwoStep(kind, bytes) {
  const rule = TWO_STEP[kind]
  if (bytes.length > rule.maxBytes) throw new Rejected(rule.tooBig)
  if (kind === 'regulamin') {
    if (!PDF_MAGIC.every((b, i) => bytes[i] === b)) throw new Rejected(REGULAMIN_BAD)
    return { meta: { bytes: bytes.length } }
  }
  // Size is capped above before the regex-based parser sees the text.
  try {
    const { km, upM, downM, points, profile } = parseGpx(new TextDecoder().decode(bytes))
    return { meta: { km, upM, downM, points, profile } }
  } catch (err) {
    if (err instanceof GpxError) throw new Rejected(err.message)
    throw err
  }
}

/** Stores a validated file in the public bucket and records it; removes the object if the row fails. */
async function store(admin, { eventId, kind, bytes, ext, contentType, meta, userId }) {
  const path = `${eventId}/${kind}/${crypto.randomUUID()}.${ext}`
  const { error: upErr } = await admin.storage.from(FILES).upload(path, bytes, { contentType, upsert: false })
  if (upErr) throw upErr
  const { data, error } = await admin.from('registration_uploads')
    .insert({ event_id: eventId, kind, path, meta, uploaded_by: userId }).select('id').single()
  if (error) {
    await admin.storage.from(FILES).remove([path])
    throw error
  }
  const { data: pub } = admin.storage.from(FILES).getPublicUrl(path)
  return { uploadId: data.id, url: pub.publicUrl, meta }
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
  const { eventId, kind, action, fileName, dataUrl, pendingPath } = body ?? {}

  let pendingToRemove = null
  try {
    const loaded = await loadOrganizerEvent(admin, eventId, session, { write: true, req })
    if (loaded instanceof Response) return loaded
    const { settings } = loaded

    const audit = (target, payload) => logOrganizerAction(admin, req, {
      actorId: session.userId, clubId: settings.club_id, eventId, action: 'file_uploaded', target, payload,
    })

    if (kind === 'poster' && action === undefined) {
      const file = await poster(dataUrl)
      const meta = { ...file.meta, fileName: cleanFileName(fileName) }
      const data = await store(admin, { eventId, kind, ...file, meta, userId: session.userId })
      await audit(data.uploadId, { kind })
      return json({ data }, 201, req)
    }

    if (!Object.hasOwn(TWO_STEP, kind ?? '')) return json({ error: INVALID }, 400, req)

    if (action === 'start') {
      const path = `${eventId}/${crypto.randomUUID()}`
      const { data, error } = await admin.storage.from(PENDING).createSignedUploadUrl(path)
      if (error) throw error
      return json({ data: { pendingPath: data.path, signedUrl: data.signedUrl, token: data.token } }, 200, req)
    }

    if (action === 'finish') {
      // Only this event's own pending objects: never read or delete another event's.
      if (typeof pendingPath !== 'string' || !new RegExp(`^${eventId}/${UUID}$`, 'i').test(pendingPath)) {
        return json({ error: INVALID }, 400, req)
      }
      pendingToRemove = pendingPath
      const { data: blob, error: dlErr } = await admin.storage.from(PENDING).download(pendingPath)
      if (dlErr || !blob) throw new Rejected(TWO_STEP[kind].tooBig)
      if (blob.size > TWO_STEP[kind].maxBytes) throw new Rejected(TWO_STEP[kind].tooBig)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const { meta } = checkTwoStep(kind, bytes)
      const { ext, contentType } = TWO_STEP[kind]
      const data = await store(admin, { eventId, kind, bytes, ext, contentType, meta, userId: session.userId })
      await audit(data.uploadId, { kind })
      return json({ data }, 201, req)
    }

    return json({ error: INVALID }, 400, req)
  } catch (err) {
    if (err instanceof Rejected) return json({ error: err.message }, 400, req)
    console.error('upload-registration-file error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  } finally {
    if (pendingToRemove) {
      const { error } = await admin.storage.from(PENDING).remove([pendingToRemove])
      if (error) console.error('upload-registration-file: pending cleanup failed:', error.message)
    }
  }
})
