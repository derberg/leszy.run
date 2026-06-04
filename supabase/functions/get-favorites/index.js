import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  // Own starred events with display details (rejected events drop out here)
  const { data: favs } = await supabaseAdmin
    .from('event_favorites')
    .select('created_at, calendar_events(id, name, date, location, status, registration_deadline, registration_url)')
    .eq('user_id', session.userId)
    .order('created_at', { ascending: false })

  const events = (favs ?? [])
    .map((f) => f.calendar_events)
    .filter((e) => e && ['active', 'cancelled'].includes(e.status))

  // Club counts: favorites of OTHER members of my club who haven't opted out
  const clubCounts = {}
  const { data: me } = await supabaseAdmin
    .from('profiles')
    .select('club_id')
    .eq('id', session.userId)
    .single()

  if (me?.club_id) {
    const { data: mates } = await supabaseAdmin
      .from('profiles')
      .select('id, privacy_settings')
      .eq('club_id', me.club_id)
      .neq('id', session.userId)
      .is('deleted_at', null)

    const visibleIds = (mates ?? [])
      .filter((m) => (m.privacy_settings?.favorites ?? true) !== false)
      .map((m) => m.id)

    if (visibleIds.length) {
      const { data: mateFavs } = await supabaseAdmin
        .from('event_favorites')
        .select('event_id')
        .in('user_id', visibleIds)
      for (const f of mateFavs ?? []) {
        clubCounts[f.event_id] = (clubCounts[f.event_id] || 0) + 1
      }
    }
  }

  return json({ events, clubCounts }, 200, req)
})
