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

  let markSeen = false
  try {
    const body = await req.json()
    markSeen = body?.markSeen === true
  } catch { /* empty body is fine */ }

  const [{ data: profile }, { data: favs }] = await Promise.all([
    supabaseAdmin.from('profiles').select('notifications_seen_at').eq('id', session.userId).single(),
    supabaseAdmin.from('event_favorites').select('event_id, created_at').eq('user_id', session.userId),
  ])

  const favMap = new Map((favs ?? []).map((f) => [f.event_id, f.created_at]))
  let notifications = []

  if (favMap.size) {
    const { data: notifs } = await supabaseAdmin
      .from('event_notifications')
      .select('id, event_id, type, created_at, calendar_events(name, date, status)')
      .in('event_id', [...favMap.keys()])
      .order('created_at', { ascending: false })
      // limit applies BEFORE the JS before-star filter below — acceptable
      // because each event carries at most 3 notification types and the
      // query already spans only the user's starred events
      .limit(50)

    notifications = (notifs ?? [])
      // never notify about things that happened before the user starred
      .filter((n) => new Date(n.created_at) > new Date(favMap.get(n.event_id)))
      .map((n) => ({
        id: n.id,
        event_id: n.event_id,
        type: n.type,
        created_at: n.created_at,
        event_name: n.calendar_events?.name ?? null,
        event_date: n.calendar_events?.date ?? null,
      }))
  }

  const seenAt = profile?.notifications_seen_at
  const unseenCount = notifications
    .filter((n) => !seenAt || new Date(n.created_at) > new Date(seenAt)).length

  if (markSeen) {
    await supabaseAdmin
      .from('profiles')
      .update({ notifications_seen_at: new Date().toISOString() })
      .eq('id', session.userId)
  }

  return json({ notifications, unseenCount }, 200, req)
})
