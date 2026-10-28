import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { warsawToday } from '../_shared/registration/dates.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

const camelKey = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const camel = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [camelKey(k), v]))

const warsawTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
const hhmm = (iso) => warsawTime.format(new Date(iso))

async function rows(query) {
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

// POST { eventId } → the wizard's whole event: settings, competitions (with the
// fixed price in grosze), office hours as Warsaw days and times, age and kids
// groups, consents, uploads, pending changes, registered count and the
// caller's role. Any active member of the owning club may read it.
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
    const { settings, role } = loaded
    const eventId = settings.event_id

    const [competitions, hours, consents, uploads, pendingRows, registered] = await Promise.all([
      rows(admin.from('competitions').select('*').eq('event_id', eventId).order('sort_order')),
      rows(admin.from('office_hours').select('id, starts_at, ends_at').eq('event_id', eventId).order('starts_at')),
      rows(admin.from('event_consents').select('id, kind, text, sort_order').eq('event_id', eventId).order('sort_order')),
      rows(admin.from('registration_uploads').select('id, kind, path, meta, created_at').eq('event_id', eventId).order('created_at')),
      rows(admin.from('registration_pending_changes').select('payload, changed_fields, updated_at').eq('event_id', eventId)),
      admin.from('registrations').select('id', { count: 'exact', head: true })
        .eq('event_id', eventId).in('status', ['confirmed', 'pending_payment']),
    ])
    if (registered.error) throw registered.error

    const categoryIds = competitions.map((c) => c.category_id)
    const [prices, ageGroups, kidsGroups] = categoryIds.length
      ? await Promise.all([
        rows(admin.from('competition_prices').select('category_id, amount, price_tiers(ends_on)').in('category_id', categoryIds)),
        rows(admin.from('age_groups').select('*').in('category_id', categoryIds).order('min_age')),
        rows(admin.from('kids_groups').select('*').in('category_id', categoryIds).order('birth_year_from')),
      ])
      : [[], [], []]

    // Fixed pricing has exactly one open-ended tier; that is the price shown.
    const priceOf = new Map(prices.filter((p) => p.price_tiers?.ends_on == null).map((p) => [p.category_id, p.amount]))

    return json({ data: {
      settings: {
        ...camel(settings),
        opensOn: settings.opens_at ? warsawToday(new Date(settings.opens_at)) : null,
        closesOn: settings.closes_at ? warsawToday(new Date(new Date(settings.closes_at).getTime() - 1)) : null,
      },
      competitions: competitions.map((c) => ({ ...camel(c), priceGrosze: priceOf.get(c.category_id) ?? null })),
      officeHours: hours.map((h) => ({
        id: h.id, date: warsawToday(new Date(h.starts_at)), from: hhmm(h.starts_at), to: hhmm(h.ends_at),
        startsAt: h.starts_at, endsAt: h.ends_at,
      })),
      ageGroups: ageGroups.map(camel),
      kidsGroups: kidsGroups.map(camel),
      consents: consents.map(camel),
      uploads: uploads.map(camel),
      pending: pendingRows[0] ? camel(pendingRows[0]) : null,
      registeredCount: registered.count ?? 0,
      role,
    } }, 200, req)
  } catch (err) {
    console.error('get-registration-event error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
