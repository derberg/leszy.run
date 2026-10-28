import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// Upload ids a staged section names (basics: regulamin, poster; competitions: GPX).
function stagedUploadIds(payload) {
  const ids = [payload?.basics?.regulamin_upload_id, payload?.basics?.poster_upload_id,
    ...(payload?.competitions?.items ?? []).map((i) => i?.gpx_upload_id)]
  return [...new Set(ids.filter((id) => typeof id === 'string'))]
}

// POST { eventId, withPending } → { data: { raw, pending } }: the event page as
// a runner would see it (registration_raw, any state, drafts included), for any
// active member of the owning club. With withPending, `pending` is the staged
// changes ({ payload, changedFields, updatedAt, uploads: { id: { path, meta } } })
// for mergePending() in public/src/lib/eventPageModel.js; else null. Everyone
// else, anonymous included, gets 404: the preview must not reveal that a draft
// exists.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  try {
    const session = await getSession(req, admin)
    if (!session) return json({ error: 'Not found' }, 404, req)
    const loaded = await loadOrganizerEvent(admin, body?.eventId, session, { write: false, req })
    if (loaded instanceof Response) return loaded
    const eventId = loaded.settings.event_id

    const { data: raw, error } = await admin.rpc('registration_raw', { p_event_id: eventId })
    if (error) throw error

    let pending = null
    if (body?.withPending === true) {
      const { data: row, error: pErr } = await admin.from('registration_pending_changes')
        .select('payload, changed_fields, updated_at').eq('event_id', eventId).maybeSingle()
      if (pErr) throw pErr
      if (row) {
        const ids = stagedUploadIds(row.payload)
        const { data: files, error: uErr } = ids.length
          ? await admin.from('registration_uploads').select('id, kind, path, meta').eq('event_id', eventId).in('id', ids)
          : { data: [], error: null }
        if (uErr) throw uErr
        pending = {
          payload: row.payload,
          changedFields: row.changed_fields,
          updatedAt: row.updated_at,
          uploads: Object.fromEntries(files.map((f) => [f.id, { path: f.path, meta: f.kind === 'gpx' ? f.meta : {} }])),
        }
      }
    }

    return json({ data: { raw, pending } }, 200, req)
  } catch (err) {
    console.error('preview-registration-event error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
