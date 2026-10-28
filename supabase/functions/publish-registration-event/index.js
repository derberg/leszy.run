import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { AGREEMENT_REQUIRED, clubHasAgreement, loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { publishChecklist, blockingMessage, SLUG_TAKEN_ITEM } from '../_shared/registration/checklist.js'
import { eventPageUrl } from '../_shared/registration/slug.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

const NOT_DRAFT = { error: 'Wydarzenie jest już opublikowane.', code: 'not_draft' }
const ACTIONS = ['publish']

const refused = (blocking, req) => json({ error: blockingMessage(blocking), blocking }, 409, req)

const camelKey = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const camel = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [camelKey(k), v]))

// What publishChecklist() reads, in get-registration-event's shape.
async function checklistInput(admin, settings) {
  const [competitions, hours] = await Promise.all([
    admin.from('competitions').select('*').eq('event_id', settings.event_id),
    admin.from('office_hours').select('id').eq('event_id', settings.event_id).limit(1),
  ])
  if (competitions.error) throw competitions.error
  if (hours.error) throw hours.error
  return { settings: camel(settings), competitions: competitions.data.map(camel), officeHours: hours.data }
}

// POST { eventId, action: 'publish' } → 200 { data: { state: 'published', url } }.
// Owner or admin of the owning club, with the current organizer agreement.
// 409 { error: 'Uzupełnij: …', blocking } while the checklist has blocking
// items (or an ordinary event took the slug meanwhile); 409 not_draft once
// published. The RPC flips the state and writes the events, categories and
// calendar rows in one transaction.
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
    const { eventId, action } = body ?? {}
    const loaded = await loadOrganizerEvent(admin, eventId, session, { write: true, req })
    if (loaded instanceof Response) return loaded
    const { settings } = loaded
    if (!ACTIONS.includes(action)) return json({ error: 'Nieznana akcja.' }, 400, req)
    if (settings.state !== 'draft') return json(NOT_DRAFT, 409, req)
    if (!(await clubHasAgreement(admin, settings.club_id))) return json(AGREEMENT_REQUIRED, 409, req)

    const { blocking } = publishChecklist({ ...(await checklistInput(admin, settings)), hasAgreement: true })
    if (blocking.length) return refused(blocking, req)

    const { data, error } = await admin.rpc('publish_registration_event', {
      p_event_id: settings.event_id, p_actor: session.userId, p_expected_updated_at: settings.updated_at,
    })
    if (error) {
      const msg = error.message ?? ''
      if (msg === 'not_draft') return json(NOT_DRAFT, 409, req)
      if (msg === 'slug_taken') return refused([SLUG_TAKEN_ITEM], req)
      if (msg === 'changed') {
        return json({ error: 'Wydarzenie zmieniło się w trakcie publikacji. Spróbuj jeszcze raz.', code: 'changed' }, 409, req)
      }
      if (msg === 'forbidden') return json({ error: 'Brak uprawnień.' }, 403, req)
      throw error
    }

    await logOrganizerAction(admin, req, {
      actorId: session.userId, clubId: settings.club_id, eventId: settings.event_id, action: 'published',
      target: settings.event_id,
    })
    return json({ data: { state: data.state, url: eventPageUrl(data.slug) } }, 200, req)
  } catch (err) {
    console.error('publish-registration-event error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
