import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkAndAwardBadges } from '../_shared/badge-check.js'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { checkAndIncrement } from '../_shared/throttle.js'
import { validateContribution } from '../_shared/contributionValidation.js'

function json(body, status = 200, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

const VALID_TYPES = ['event_report', 'event_submission', 'general_feedback']
// Every contribution lands in an admin's review queue (and a submission in
// calendar_events). Unthrottled, one account could fill the queue.
const CONTRIBUTION_LIMIT = 20
const DAY_SECONDS = 24 * 60 * 60

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Auth required — anonymous submissions are no longer supported
    const session = await getSession(req, supabaseAdmin)
    if (!session) return json({ error: 'Authorization required' }, 401, req)

    let body
    try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid JSON' }, 400, req)
    const { type, reference_id, payload = {} } = body
    if (!VALID_TYPES.includes(type)) {
      return json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` }, 400, req)
    }
    const invalid = validateContribution({ type, reference_id, payload })
    if (invalid) return json({ error: `Invalid contribution: ${invalid}` }, 400, req)

    const throttle = await checkAndIncrement(supabaseAdmin, `contribution:${session.userId}`, CONTRIBUTION_LIMIT, { windowSeconds: DAY_SECONDS })
    if (!throttle.allowed) {
      return new Response(JSON.stringify({ error: 'Zbyt wiele zgłoszeń. Spróbuj ponownie jutro.' }), {
        status: 429,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'retry-after': String(throttle.retryAfterSec) },
      })
    }

    let result

    if (type === 'event_report') {
      // calendar_event_reports schema:
      //   id (uuid, default gen_random_uuid())
      //   calendar_event_id (uuid, NOT NULL)
      //   field (text, NOT NULL) — which field is being reported
      //   old_value (text, nullable)
      //   suggested_value (text, nullable)
      //   source_url (text, nullable)
      //   note (text, nullable)
      //   status (text, NOT NULL, default 'pending')
      //   created_at (timestamptz, NOT NULL, default now())
      //   reviewed_at (timestamptz, nullable)
      //   user_id (uuid, nullable)
      const row = {
        calendar_event_id: reference_id,
        user_id: session.userId,
        field: payload.field ?? 'general',
      }
      if (payload.old_value !== undefined)       row.old_value = payload.old_value
      if (payload.suggested_value !== undefined) row.suggested_value = payload.suggested_value
      if (payload.source_url !== undefined)      row.source_url = payload.source_url
      if (payload.note !== undefined)            row.note = payload.note

      const { data, error } = await supabaseAdmin
        .from('calendar_event_reports')
        .insert(row)
        .select()
        .single()
      if (error) throw error
      result = data

    } else if (type === 'event_submission') {
      // calendar_events schema (safe subset for community submissions):
      //   name (text, NOT NULL)
      //   date (date, NOT NULL)
      //   source (text, NOT NULL) — use 'community'
      //   status (text, nullable, default 'pending')
      //   submitted_by (uuid, nullable)
      //   location (text, nullable)
      //   voivodeship (text, nullable)
      //   registration_url (text, nullable)
      //   website (text, nullable)
      const row = {
        source: 'community',
        status: 'pending',
        submitted_by: session.userId,
        name: payload.name,
        date: payload.date,
      }
      if (payload.location !== undefined)              row.location = payload.location
      if (payload.voivodeship !== undefined)            row.voivodeship = payload.voivodeship
      if (payload.registration_url !== undefined)       row.registration_url = payload.registration_url
      if (payload.website !== undefined)                row.website = payload.website
      if (payload.regulamin_url !== undefined)          row.regulamin_url = payload.regulamin_url
      if (payload.distances !== undefined)              row.distances = payload.distances
      if (payload.event_type !== undefined)             row.event_type = payload.event_type
      if (payload.price_from !== undefined)             row.price_from = payload.price_from
      if (payload.price_to !== undefined)               row.price_to = payload.price_to
      if (payload.registration_deadline !== undefined)  row.registration_deadline = payload.registration_deadline
      if (payload.lat !== undefined)                    row.lat = payload.lat
      if (payload.lng !== undefined)                    row.lng = payload.lng

      const { data, error } = await supabaseAdmin
        .from('calendar_events')
        .insert(row)
        .select()
        .single()
      if (error) throw error
      result = data

    } else {
      // general_feedback schema:
      //   id (uuid, default gen_random_uuid())
      //   category (text, NOT NULL)
      //   message (text, NOT NULL)
      //   email (text, nullable)
      //   status (text, NOT NULL, default 'pending')
      //   admin_note (text, nullable)
      //   created_at (timestamptz, NOT NULL, default now())
      //   reviewed_at (timestamptz, nullable)
      //   user_id (uuid, nullable)
      const row = {
        user_id: session.userId,
        category: payload.category ?? 'general',
        message: payload.message,
      }

      const { data, error } = await supabaseAdmin
        .from('website_feedback')
        .insert(row)
        .select()
        .single()
      if (error) throw error
      result = data
    }

    await checkAndAwardBadges(supabaseAdmin, session.userId)

    return json({ data: result }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
