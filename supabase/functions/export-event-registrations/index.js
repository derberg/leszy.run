import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { loadEntries } from '../_shared/registration/organizerEntries.js'
import { filterEntries, filterSummary } from '../_shared/registration/entriesFilter.js'
import { entriesToCsv } from '../_shared/registration/entriesCsv.js'
import { warsawToday } from '../_shared/registration/dates.js'

// Runner personal data: never kept by a browser or a proxy cache.
function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

const READERS = ['owner', 'admin']
const FILTER_KEYS = ['categoryId', 'statusKey', 'q', 'partnerId']
const AUDIT_FAILED = 'Nie udało się zapisać eksportu w historii zmian. Spróbuj ponownie za chwilę.'

// Only the panel's filter keys, each a short string.
function cleanFilter(filter) {
  if (!filter || typeof filter !== 'object') return {}
  return Object.fromEntries(FILTER_KEYS
    .filter((k) => typeof filter[k] === 'string' && filter[k] !== '')
    .map((k) => [k, filter[k].slice(0, 200)]))
}

// POST { eventId, filter? } → 200 { data: { filename: 'zgloszenia-<slug>-<yyyy-mm-dd>.csv', csv } }.
// The rows are list-event-registrations' (loadEntries, every page past PostgREST's 1000), narrowed
// by the panel's own filter (filterEntries: categoryId, statusKey, q, partnerId), plus a child's
// guardian address, and written by entriesToCsv (UTF-8 BOM, `;`, formula-safe cells). The date is
// Warsaw's. Every export is logged (`csv_exported`: the row count, the filter keys used and whether
// there was a search, never the search text) before the answer leaves, and an export that could
// not be logged does not leave: 503 audit_failed (review M8). Owner and admins only, as the list:
// a member, an outsider or a disabled club 404.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const session = await getSession(req, admin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  try {
    const loaded = await loadOrganizerEvent(admin, body?.eventId, session, { write: false, req })
    if (loaded instanceof Response) return loaded
    if (!READERS.includes(loaded.role)) return json({ error: 'Not found' }, 404, req)
    const { settings } = loaded

    const filter = cleanFilter(body.filter)
    const { rows } = await loadEntries(admin, settings, { guardianEmail: true })
    const picked = filterEntries(rows, filter)
    const csv = entriesToCsv(picked)
    const filename = `zgloszenia-${settings.slug ?? settings.event_id}-${warsawToday()}.csv`
    const logged = await logOrganizerAction(admin, req, {
      actorId: session.userId, clubId: settings.club_id, eventId: settings.event_id, action: 'csv_exported',
      target: settings.event_id, payload: { rows: picked.length, filter: filterSummary(filter) },
    })
    if (!logged) return json({ error: AUDIT_FAILED, code: 'audit_failed' }, 503, req)
    return json({ data: { filename, csv } }, 200, req)
  } catch (err) {
    console.error('export-event-registrations error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
