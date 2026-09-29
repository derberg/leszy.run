import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { checkAndIncrement } from '../_shared/throttle.js'
import { isEmailRetired } from '../_shared/deletedEmails.js'

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function json(body, status, req, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...extraHeaders },
  })
}

const SESSION_MAX_AGE = 90 * 24 * 60 * 60 // 90 days in seconds

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  try {
    const { email, code } = await req.json()

    if (!email || !code || !/^\d{6}$/.test(String(code).trim())) {
      return json({ error: 'Nieprawidłowe dane.' }, 400, req)
    }

    const normalizedEmail = email.toLowerCase().trim()
    const trimmedCode = String(code).trim()
    const now = new Date().toISOString()

    // Guessing is bounded per address as well as per code: requesting a new code
    // resets the 3-attempt counter, so without this an attacker could keep
    // buying fresh guesses. auth-request-code is throttled; this step was not.
    const guessThrottle = await checkAndIncrement(supabaseAdmin, `verify:${normalizedEmail}`, 15)
    if (!guessThrottle.allowed) {
      return new Response(JSON.stringify({ error: 'Zbyt wiele prób. Spróbuj ponownie później.' }), {
        status: 429,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'retry-after': String(guessThrottle.retryAfterSec) },
      })
    }

    // purpose matters: the account-deletion OTP is presented to the user as a
    // confirmation of a destructive action, not as a login credential. Without
    // this filter, anyone who saw that mail within its 10 minutes could type the
    // code at /login and get a 90-day session.
    const { data: codes } = await supabaseAdmin
      .from('auth_codes')
      .select('id')
      .eq('email', normalizedEmail)
      .eq('purpose', 'login')
      .eq('used', false)
      .gt('expires_at', now)
      .order('created_at', { ascending: false })
      .limit(1)

    const loginCode = codes?.[0]
    if (!loginCode) {
      return json({ error: 'Kod wygasł lub nie istnieje. Poproś o nowy.' }, 400, req)
    }

    // One statement both counts the attempt and decides whether there was one
    // left. Read-then-write let every request that got its SELECT in before the
    // first UPDATE committed pass the same check, so the 3-attempt cap was worth
    // however many guesses an attacker could put in flight at once.
    const { data: claimedHash, error: claimErr } = await supabaseAdmin
      .rpc('claim_auth_code_attempt', { p_code_id: loginCode.id, p_max: 3 })
    if (claimErr) throw claimErr
    // NULL means used, expired, or out of attempts — including the harmless
    // case of a double-submitted form whose first request already consumed the
    // code, so the message must not insist they ran out of guesses.
    if (!claimedHash) {
      return json({ error: 'Ten kod jest już nieaktualny. Poproś o nowy.' }, 403, req)
    }

    const incomingHash = await sha256hex(trimmedCode)
    if (incomingHash !== claimedHash) {
      return json({ error: 'Nieprawidłowy kod.' }, 401, req)
    }

    await supabaseAdmin.from('auth_codes').update({ used: true }).eq('id', loginCode.id)

    // Find or create profile
    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, username')
      .eq('email', normalizedEmail)
      .maybeSingle()

    let profile = existingProfile
    if (!profile) {
      // Nothing under this address — but it may be one we retired. Checked here
      // as well as in auth-request-code, because this is the step that would
      // actually create the account.
      if (await isEmailRetired(supabaseAdmin, normalizedEmail)) {
        return json({ error: 'To konto zostało usunięte. Ten adres email nie może być ponownie użyty.' }, 403, req)
      }
      const newId = crypto.randomUUID()
      const { data: newProfile, error: insertError } = await supabaseAdmin
        .from('profiles')
        .insert({ id: newId, email: normalizedEmail })
        .select('id, username')
        .single()
      if (insertError) throw insertError
      profile = newProfile
    }

    // Create session
    const sessionToken = randomToken()
    const sessionExpires = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString()

    const { error: sessionError } = await supabaseAdmin
      .from('auth_sessions')
      .insert({ id: sessionToken, user_id: profile.id, email: normalizedEmail, expires_at: sessionExpires })
    if (sessionError) throw sessionError

    const cookie = `leszy_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`

    const hasUsername = Boolean(profile.username)

    return json(
      { success: true, hasUsername },
      200,
      req,
      { 'Set-Cookie': cookie }
    )
  } catch (err) {
    console.error(err)
    return json({ error: 'Błąd serwera.' }, 500, req)
  }
})
