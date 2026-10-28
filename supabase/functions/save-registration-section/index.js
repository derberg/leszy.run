import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { validateSection } from '../_shared/registration/sections.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

const INVALID = 'Nieprawidłowe dane.'

// RPC errors the organizer can act on; anything else is a 500.
function rpcErrorResponse(error, req) {
  const msg = error?.message ?? ''
  if (msg === 'not_draft') return json({ error: 'Wydarzenie jest już opublikowane.', code: 'not_draft' }, 409, req)
  if (msg === 'slug_taken') {
    return json({ error: 'Ten adres jest już zajęty.', fields: { slug: 'Ten adres jest już zajęty.' } }, 422, req)
  }
  if (msg === 'foreign_id') return json({ error: INVALID, fields: {} }, 422, req)
  if (msg === 'competition_locked') {
    return json({ error: 'Tej konkurencji nie można już usunąć.', code: 'competition_locked' }, 409, req)
  }
  if (msg.startsWith('capacity_below_taken:')) {
    return json({
      error: 'Limit nie może być mniejszy niż liczba zapisanych.', code: 'capacity_below_taken',
      categoryId: msg.slice('capacity_below_taken:'.length),
    }, 409, req)
  }
  // check_violation (e.g. opens_at < closes_at against a stored value), bad casts
  if (['23514', '22P02', '22007', '22008', '22003'].includes(error?.code)) return json({ error: INVALID, fields: {} }, 422, req)
  return null
}

// POST { eventId, section, value } → 200 { data: { savedAt, …ids } }.
// Draft events only in this step (published events stage changes: Task 7).
// The audit row records the section name, never the values.
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
    const { eventId, section, value } = body ?? {}
    const loaded = await loadOrganizerEvent(admin, eventId, session, { write: true, req })
    if (loaded instanceof Response) return loaded
    const { settings } = loaded
    if (settings.state !== 'draft') {
      return json({ error: 'Wydarzenie jest już opublikowane.', code: 'not_draft' }, 409, req)
    }

    const checked = validateSection(section, value, { state: settings.state, eventDate: settings.event_date })
    if (!checked.ok) return json({ error: 'Popraw zaznaczone pola.', fields: checked.errors }, 422, req)

    const { data, error } = await admin.rpc('save_registration_section', {
      p_event_id: eventId, p_section: section, p_value: checked.value,
    })
    if (error) {
      const mapped = rpcErrorResponse(error, req)
      if (mapped) return mapped
      throw error
    }

    await logOrganizerAction(admin, req, {
      actorId: session.userId, clubId: settings.club_id, eventId, action: 'section_saved', payload: { section },
    })
    return json({ data }, 200, req)
  } catch (err) {
    console.error('save-registration-section error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
