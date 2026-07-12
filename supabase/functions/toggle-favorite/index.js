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

  try {
    const { event_id } = await req.json()
    if (!event_id) return json({ error: 'event_id required' }, 400, req)

    // Only events visible in the public UI can be starred
    const { data: event } = await supabaseAdmin
      .from('calendar_events')
      .select('id, status')
      .eq('id', event_id)
      .single()
    if (!event || !['active', 'cancelled'].includes(event.status)) {
      return json({ error: 'Event not found' }, 404, req)
    }

    const { data: existing } = await supabaseAdmin
      .from('event_favorites')
      .select('event_id')
      .eq('user_id', session.userId)
      .eq('event_id', event_id)
      .maybeSingle()

    if (existing) {
      const { error } = await supabaseAdmin
        .from('event_favorites')
        .delete()
        .eq('user_id', session.userId)
        .eq('event_id', event_id)
      if (error) return json({ error: 'Delete failed' }, 500, req)
      return json({ starred: false }, 200, req)
    }

    const { error } = await supabaseAdmin
      .from('event_favorites')
      .insert({ user_id: session.userId, event_id })
    // 23505 = unique violation (double-click race) — treat as already starred
    if (error && error.code !== '23505') return json({ error: 'Insert failed' }, 500, req)
    return json({ starred: true }, 200, req)
  } catch {
    return json({ error: 'Invalid request' }, 400, req)
  }
})
