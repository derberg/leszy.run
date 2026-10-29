// A runner's own check-in from the SMS link (/events/:slug/checkin?p=&t=).
// It replaces two direct calls with the publishable key:
//   - get_participant_for_checkin(id), which returned the phone and birth date
//     of ANY participant to anyone, with no PIN; the ids are public, so that
//     was the whole register
//   - INSERT into checkins / checkin_documents, which let anyone check anyone
//     in (a no-show then gets gun time and becomes DNF instead of DNS) and
//     record "accepted" against any document
// The link's token (_shared/checkinToken.js) is what proves the link came from
// the SMS. A wrong token and an unknown participant get the same 404.
//
// Body: { action: 'get' | 'confirm', event_id, participant_id, token, acknowledged? }
//   get     → { data: { participant: { id, bib_number, first_name, last_name,
//                 category_id, emoji, tshirt_size, minor }, checkedIn } }
//   confirm → { data: { checkedIn: true } }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { checkinToken, sameToken } from '../_shared/checkinToken.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// Same rule the page used client-side, now evaluated where the birth date is.
function isMinor(birthDate, eventDate) {
  if (!birthDate || !eventDate) return false
  const birth = new Date(birthDate)
  const day = new Date(eventDate)
  let age = day.getFullYear() - birth.getFullYear()
  const m = day.getMonth() - birth.getMonth()
  if (m < 0 || (m === 0 && day.getDate() < birth.getDate())) age -= 1
  return age < 18
}

function applies(doc, minor) {
  if (doc.required_for === 'all') return true
  if (doc.required_for === 'minors') return minor
  if (doc.required_for === 'adults') return !minor
  return false
}

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, req)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }
  const { action, event_id: eventId, participant_id: participantId, token } = body ?? {}
  if (action !== 'get' && action !== 'confirm') return json({ error: 'Invalid action' }, 400, req)
  if (!UUID_RE.test(String(eventId ?? '')) || !UUID_RE.test(String(participantId ?? ''))) {
    return json({ error: 'Invalid id' }, 400, req)
  }
  const notFound = () => json({ error: 'Not found' }, 404, req)
  if (typeof token !== 'string' || token.length === 0) return notFound()

  const admin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const [{ data: p, error: pErr }, { data: secret, error: sErr }] = await Promise.all([
    admin.from('participants')
      .select('id, event_id, bib_number, first_name, last_name, category_id, emoji, tshirt_size, birth_date, deleted_at, removed_at')
      .eq('id', participantId).maybeSingle(),
    admin.from('event_secrets').select('checkin_link_key').eq('event_id', eventId).maybeSingle(),
  ])
  if (pErr || sErr) return json({ error: 'Lookup failed' }, 500, req)
  if (!p || p.deleted_at || p.removed_at || p.event_id !== eventId || !secret?.checkin_link_key) return notFound()
  if (!sameToken(await checkinToken(secret.checkin_link_key, participantId), token)) return notFound()

  const { data: event, error: eErr } = await admin.from('events').select('date').eq('id', eventId).maybeSingle()
  if (eErr || !event) return json({ error: 'Lookup failed' }, 500, req)
  const minor = isMinor(p.birth_date, event.date)

  const { data: existing, error: cErr } = await admin
    .from('checkins').select('id').eq('participant_id', participantId).maybeSingle()
  if (cErr) return json({ error: 'Lookup failed' }, 500, req)

  if (action === 'get') {
    return json({
      data: {
        participant: {
          id: p.id, bib_number: p.bib_number, first_name: p.first_name, last_name: p.last_name,
          category_id: p.category_id, emoji: p.emoji, tshirt_size: p.tshirt_size, minor,
        },
        checkedIn: !!existing,
      },
    }, 200, req)
  }

  if (existing) return json({ data: { checkedIn: true } }, 200, req)

  // The page shows the runner every "acknowledge" document that applies to
  // them and enables the button only once all are ticked. The server holds
  // the same line, so a scripted call cannot record a check-in without them.
  const { data: docs, error: dErr } = await admin
    .from('event_documents').select('id, type, required_for').eq('event_id', eventId)
  if (dErr) return json({ error: 'Lookup failed' }, 500, req)
  const applicable = (docs ?? []).filter(d => d.type !== 'info' && applies(d, minor))
  const acknowledged = new Set(Array.isArray(body.acknowledged) ? body.acknowledged.map(String) : [])
  const missing = applicable.filter(d => d.type === 'acknowledge' && !acknowledged.has(d.id))
  if (missing.length > 0) return json({ error: 'Documents not acknowledged' }, 400, req)

  const { data: checkin, error: insErr } = await admin
    .from('checkins').insert({ participant_id: participantId, event_id: eventId }).select('id').single()
  if (insErr?.code === '23505') return json({ data: { checkedIn: true } }, 200, req)
  if (insErr) {
    console.error('[self-checkin] checkin insert failed', insErr)
    return json({ error: 'Check-in failed' }, 500, req)
  }

  if (applicable.length > 0) {
    const { error: docErr } = await admin.from('checkin_documents').insert(applicable.map(d => ({
      checkin_id: checkin.id,
      document_id: d.id,
      status: d.type === 'acknowledge' ? 'accepted' : 'pending',
    })))
    // Same as before: the check-in stands even if a document row fails.
    if (docErr) console.error('[self-checkin] document insert failed', docErr)
  }

  return json({ data: { checkedIn: true } }, 200, req)
})
