import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { moneyLiveFor, payloadWithoutMoneyFeatures, rawWithoutMoneyFeatures } from '../_shared/registration/moneyLive.js'
import { allRows } from '../_shared/registration/allRows.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

/**
 * The event's public partners as /api/event serves them (public/src/lib/publicPartners.js): the
 * service role sees every row, so `is_public` is filtered here, and only the four columns a runner
 * may see leave. Partners apply at once (organizer-partners), so there is nothing staged to merge.
 */
async function publicPartners(admin, eventId) {
  const rows = await allRows(() => admin.from('event_partners')
    .select('id, name, logo_url, website_url')
    .eq('event_id', eventId).eq('is_public', true)
    .order('sort_order').order('id'))
  return rows.map((p) => ({ id: p.id, name: p.name, logoUrl: p.logo_url ?? null, websiteUrl: p.website_url ?? null }))
}

// Upload ids a staged section names (basics: regulamin, poster; competitions: GPX; extras: images).
function stagedUploadIds(payload) {
  const ids = [payload?.basics?.regulamin_upload_id, payload?.basics?.poster_upload_id,
    ...(payload?.competitions?.items ?? []).map((i) => i?.gpx_upload_id),
    ...(payload?.extras?.items ?? []).map((x) => x?.image_upload_id)]
  return [...new Set(ids.filter((id) => typeof id === 'string'))]
}

// POST { eventId, withPending } → { data: { raw, pending } }: the event page as
// a runner would see it (registration_raw, any state, drafts included), for any
// active member of the owning club. With withPending, `pending` is the staged
// changes ({ payload, changedFields, updatedAt, uploads: { id: { path, meta } }, sold: { variantId: n } })
// for mergePending() in public/src/lib/eventPageModel.js; else null. Everyone
// else, anonymous included, gets 404: the preview must not reveal that a draft
// exists. With Plan 7's money features off (moneyLiveFor), both are stripped of donations and
// extras exactly as /api/event strips the public page, so the preview never shows what a runner
// cannot see (NB-3). `raw.partners` is the event's public partners, as /api/event adds them.
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

    const moneyLive = moneyLiveFor(req)
    const { data: liveRaw, error } = await admin.rpc('registration_raw', { p_event_id: eventId })
    if (error) throw error
    const raw = { ...(moneyLive ? liveRaw : rawWithoutMoneyFeatures(liveRaw)), partners: await publicPartners(admin, eventId) }

    let pending = null
    if (body?.withPending === true) {
      const { data: row, error: pErr } = await admin.from('registration_pending_changes')
        .select('payload, changed_fields, updated_at').eq('event_id', eventId).maybeSingle()
      if (pErr) throw pErr
      if (row) {
        const payload = moneyLive ? row.payload : payloadWithoutMoneyFeatures(row.payload)
        const changedFields = moneyLive ? row.changed_fields : (row.changed_fields ?? []).filter((f) => f !== 'extras')
        const ids = stagedUploadIds(payload)
        const { data: files, error: uErr } = ids.length
          ? await admin.from('registration_uploads').select('id, kind, path, meta').eq('event_id', eventId).in('id', ids)
          : { data: [], error: null }
        if (uErr) throw uErr
        // What each staged live variant already sold: the preview shows stock less sales.
        const variantIds = (payload?.extras?.items ?? []).flatMap((x) => (x?.variants ?? []).map((v) => v?.id)).filter((id) => typeof id === 'string')
        const { data: sold, error: sErr } = variantIds.length
          ? await admin.from('extra_variants').select('id, sold, extras!inner(event_id)').in('id', variantIds).eq('extras.event_id', eventId)
          : { data: [], error: null }
        if (sErr) throw sErr
        pending = {
          payload,
          changedFields,
          updatedAt: row.updated_at,
          uploads: Object.fromEntries(files.map((f) => [f.id, { path: f.path, meta: f.kind === 'gpx' ? f.meta : {} }])),
          sold: Object.fromEntries(sold.map((v) => [v.id, v.sold])),
        }
      }
    }

    return json({ data: { raw, pending } }, 200, req)
  } catch (err) {
    console.error('preview-registration-event error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
