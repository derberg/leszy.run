import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { clientIp } from '../_shared/clientIp.js'

// The races a person added that went live, for their public profile at /u/<username>.
//
// The profile page used to read calendar_events with the publishable key, and with it the
// whole race calendar was readable by anyone, pending and rejected rows included. Now the
// table is service-role only, and this answers the one question the page asks: the names
// and dates of the person's accepted submissions. It needs no session, like the page.
// Nothing about a pending or rejected submission leaves, nor any other column.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Per-instance cap on lookups per IP, the same shape as preview-invite's. It only keeps a
// script from using the function as a free database probe; the answer is public anyway.
const WINDOW_MS = 15 * 60 * 1000
const MAX_PER_WINDOW = 300
const attempts = new Map()

function throttled(ip) {
  const now = Date.now()
  if (attempts.size > 10_000) {
    for (const [key, entry] of attempts) {
      if (now - entry.windowStart > WINDOW_MS) attempts.delete(key)
    }
  }
  const entry = attempts.get(ip)
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attempts.set(ip, { count: 1, windowStart: now })
    return false
  }
  entry.count++
  return entry.count > MAX_PER_WINDOW
}

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const ip = (await clientIp(req)) ?? 'unknown'
  if (throttled(ip)) return json({ error: 'Zbyt wiele prób. Spróbuj za kilka minut.' }, 429, req)

  try {
    const { userId } = await req.json().catch(() => ({}))
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
      return json({ error: 'Nie znaleziono użytkownika.' }, 404, req)
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Only a profile the public page can show at all (profiles_public decides that).
    const { data: profile } = await supabaseAdmin
      .from('profiles_public')
      .select('id')
      .eq('id', userId)
      .maybeSingle()
    if (!profile) return json({ error: 'Nie znaleziono użytkownika.' }, 404, req)

    // The page's former query: the 10 newest submissions, of which it showed the live ones.
    const { data, error } = await supabaseAdmin
      .from('calendar_events')
      .select('name, status, created_at')
      .eq('submitted_by', userId)
      .order('created_at', { ascending: false })
      .limit(10)
    if (error) return json({ error: 'Nie udało się wczytać zgłoszeń.' }, 500, req)

    const submissions = (data ?? [])
      .filter((s) => s.status === 'active')
      .map((s) => ({ name: s.name, status: s.status, created_at: s.created_at }))
    return json({ data: submissions }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
