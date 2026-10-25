import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { inviteState } from '../_shared/clubInvites.js'

// What an invite link leads to, for a visitor who is not logged in yet.
//
// The invite page used to send a logged-out visitor straight to a generic login
// form, so somebody who tapped an invite link never learned which club had
// invited them. Holding the code is what makes a person invited, so answering
// that person with the club's name tells them nothing they were not meant to
// know. Nothing else leaves: not who made the invite, not who a direct invite
// is addressed to, not the club's members.

// Codes are 10 hex characters (manage-club-invite). Anything else is refused
// before the database is asked.
const CODE_RE = /^[0-9a-f]{10}$/

// Per-instance cap on lookups per IP, the same shape as checkpoint-roster's.
// 40 bits of code make guessing hopeless anyway; this only keeps a script from
// using the function as a free database probe.
const WINDOW_MS = 15 * 60 * 1000
const MAX_PER_WINDOW = 60
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

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
  if (throttled(ip)) return json({ error: 'Zbyt wiele prób. Spróbuj za kilka minut.' }, 429, req)

  try {
    const { code } = await req.json().catch(() => ({}))
    if (typeof code !== 'string' || !CODE_RE.test(code)) {
      return json({ error: 'Nieprawidłowy kod zaproszenia.' }, 404, req)
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { data: invite } = await supabaseAdmin.from('club_invites')
      .select('club_id, expires_at, max_uses, uses, revoked')
      .eq('code', code)
      .maybeSingle()
    if (!invite) return json({ error: 'Nieprawidłowy kod zaproszenia.' }, 404, req)

    const { data: club } = await supabaseAdmin.from('clubs')
      .select('name')
      .eq('id', invite.club_id)
      .maybeSingle()
    if (!club) return json({ error: 'Nieprawidłowy kod zaproszenia.' }, 404, req)

    return json({
      data: {
        club: { name: club.name },
        state: inviteState(invite),
      },
    }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
