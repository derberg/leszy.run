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
    let body = {}
    try { body = await req.json() } catch { /* empty body is fine — defaults to caller's club */ }

    let clubId = body?.club_id
    if (!clubId && body?.slug) {
      const { data: bySlug } = await supabaseAdmin
        .from('clubs').select('id').eq('slug', body.slug).maybeSingle()
      clubId = bySlug?.id
      if (!clubId) {
        const { data: hist } = await supabaseAdmin
          .from('club_slug_history').select('club_id').eq('old_slug', body.slug).maybeSingle()
        clubId = hist?.club_id
      }
      if (!clubId) return json({ error: 'Klub nie istnieje.' }, 404, req)
    }
    if (!clubId) {
      const { data: profile } = await supabaseAdmin
        .from('profiles').select('club_id').eq('id', session.userId).single()
      clubId = profile?.club_id
    }
    // No club at all (profile.club_id is NULL) — same expected "no club yet"
    // state as the inactive-membership case below, so return the same 200
    // shape. A 403 here makes the client's useClub treat it as a failure and
    // /profil/klub shows the error text instead of the create/join picker.
    if (!clubId) return json({ data: { club: null } }, 200, req)

    const { data: me } = await supabaseAdmin.from('club_members')
      .select('role, hidden_public, status')
      .eq('club_id', clubId).eq('user_id', session.userId).maybeSingle()
    if (!me || me.status !== 'active') {
      // Not an active member of the target club — let the client cleanly
      // show "no club" instead of treating this as an error.
      return json({ data: { club: null } }, 200, req)
    }

    const { data: club, error: clubErr } = await supabaseAdmin
      .from('clubs')
      .select('id, name, slug, description, city, voivodeship, logo_url, is_public, owner_id, pending_owner_id, created_at')
      .eq('id', clubId).single()
    if (clubErr) throw clubErr

    // Include pending members too (so managers can approve/reject them from
    // the roster) alongside active ones; active members are listed first.
    const { data: memberRows, error: memberErr } = await supabaseAdmin
      .from('club_members')
      .select('user_id, role, hidden_public, status, profiles(display_name, nickname, privacy_settings)')
      .eq('club_id', clubId).in('status', ['active', 'pending'])
    if (memberErr) throw memberErr

    const members = (memberRows ?? [])
      .slice()
      .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1))
      .map((m) => ({
        user_id: m.user_id,
        display_name: m.profiles?.display_name ?? null,
        nickname: m.profiles?.nickname ?? null,
        role: m.role,
        hidden_public: m.hidden_public,
        status: m.status,
      }))

    // Clubmate followed events: favorites of active members who haven't opted
    // out of sharing (privacy_settings.favorites !== false), aggregated by
    // event with a per-event count. Same approach as get-favorites' clubCounts,
    // paginated past PostgREST's 1000-row response cap. Pending members are
    // excluded — they haven't joined yet.
    const visibleIds = (memberRows ?? [])
      .filter((m) => m.status === 'active')
      .filter((m) => (m.profiles?.privacy_settings?.favorites ?? true) !== false)
      .map((m) => m.user_id)

    const eventsById = {}
    if (visibleIds.length) {
      const today = new Date().toISOString().slice(0, 10)
      const pageSize = 1000
      for (let from = 0; ; from += pageSize) {
        const { data: favs } = await supabaseAdmin
          .from('event_favorites')
          .select('event_id, calendar_events(id, name, date, location, status, registration_url)')
          .in('user_id', visibleIds)
          .order('event_id')
          .range(from, from + pageSize - 1)
        for (const f of favs ?? []) {
          const ev = f.calendar_events
          if (!ev) continue
          if (!['active', 'cancelled'].includes(ev.status)) continue
          if (ev.date && ev.date < today) continue // followedEvents surfaces only upcoming events
          if (!eventsById[ev.id]) eventsById[ev.id] = { event: ev, count: 0 }
          eventsById[ev.id].count += 1
        }
        if (!favs || favs.length < pageSize) break
      }
    }
    const followedEvents = Object.values(eventsById)
      .sort((a, b) => (a.event.date || '').localeCompare(b.event.date || ''))

    return json({
      data: {
        club,
        me: { role: me.role, hidden_public: me.hidden_public },
        members,
        followedEvents,
      },
    }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
