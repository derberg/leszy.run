import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { deadlineSoonFor } from '../_shared/deadlineSoon.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// Only these have a public page to link to. A rejected event is never published
// to the static manifest, so its link 404s; a race that has already been run is
// not news. Measured 2026-09-29: 203 of 212 stored notifications belonged to
// races whose date had passed, and nothing filtered them out of the feed.
const NOTIFIABLE_STATUSES = new Set(['active', 'cancelled'])
const FEED_LIMIT = 50

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  let markSeen = false
  try {
    const body = await req.json()
    markSeen = body?.markSeen === true
  } catch { /* empty body is fine */ }

  // Everything below is wrapped: an unhandled throw escapes Deno.serve as a 500
  // WITHOUT the CORS headers, so the browser reports an opaque CORS failure
  // instead of the status, and useNotifications' .catch() quietly zeroes the
  // badge — a broken backend looked exactly like "nothing new".
  try {
    const todayIso = new Date().toISOString().slice(0, 10)

    const [{ data: profile }, favs] = await Promise.all([
      supabaseAdmin.from('profiles').select('notifications_seen_at').eq('id', session.userId).single(),
      fetchAllFavorites(supabaseAdmin, session.userId),
    ])

    const favMap = new Map(favs.map((f) => [f.event_id, f.created_at]))
    if (!favMap.size) {
      if (markSeen) await stampSeen(supabaseAdmin, session.userId)
      return json({ notifications: [], unseenCount: 0 }, 200, req)
    }

    const eventIds = [...favMap.keys()]

    // Stored notifications are the ones that are genuinely event-scoped facts:
    // registration opened, and that is it. deadline_soon is derived below
    // instead, because a stored one fires once per event and is therefore
    // invisible to everyone who starred the race afterwards.
    const { data: storedRows, error: storedErr } = await supabaseAdmin
      .from('event_notifications')
      .select('id, event_id, type, created_at, calendar_events(name, date, status)')
      .eq('type', 'registration_opened')
      .in('event_id', eventIds)
      .order('created_at', { ascending: false })
    if (storedErr) throw storedErr

    const { data: eventRows, error: evErr } = await supabaseAdmin
      .from('calendar_events')
      .select('id, name, date, status, registration_deadline')
      .in('id', eventIds)
    if (evErr) throw evErr

    const derived = (eventRows ?? [])
      .map((ev) => {
        const hit = deadlineSoonFor(ev, todayIso)
        return hit ? { ...hit, id: `deadline:${ev.id}`, calendar_events: ev } : null
      })
      .filter(Boolean)

    const rows = [...(storedRows ?? []), ...derived]
      .filter((n) => NOTIFIABLE_STATUSES.has(n.calendar_events?.status))
      .filter((n) => n.calendar_events?.date && n.calendar_events.date >= todayIso)
      // Never tell someone about something that happened before they starred it.
      .filter((n) => new Date(n.created_at) > new Date(favMap.get(n.event_id)))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      // Trimmed AFTER filtering. PostgREST's .limit() ran before it, so rows
      // that were about to be discarded ate the budget and pushed real
      // notifications out of the window for good.
      .slice(0, FEED_LIMIT)

    const seenAt = profile?.notifications_seen_at
    const unseenCount = rows
      .filter((n) => !seenAt || new Date(n.created_at) > new Date(seenAt)).length

    if (markSeen) await stampSeen(supabaseAdmin, session.userId)

    // Only the feed consumer gets the list; the badge gets just the count.
    const notifications = markSeen
      ? rows.map((n) => ({
        id: n.id,
        event_id: n.event_id,
        type: n.type,
        created_at: n.created_at,
        event_name: n.calendar_events?.name ?? null,
        event_date: n.calendar_events?.date ?? null,
      }))
      : []

    return json({ notifications, unseenCount }, 200, req)
  } catch (err) {
    console.error('get-notifications failed:', err.message)
    return json({ error: 'Nie udało się pobrać powiadomień.' }, 500, req)
  }
})

// PostgREST caps a response at 1000 rows and says nothing about it.
async function fetchAllFavorites(supabaseAdmin, userId) {
  const pageSize = 1000
  const out = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from('event_favorites')
      .select('event_id, created_at')
      .eq('user_id', userId)
      .order('event_id')
      .range(from, from + pageSize - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < pageSize) break
  }
  return out
}

async function stampSeen(supabaseAdmin, userId) {
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ notifications_seen_at: new Date().toISOString() })
    .eq('id', userId)
  if (error) console.error('get-notifications: marking seen failed:', error.message)
}
