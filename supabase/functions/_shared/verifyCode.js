import { checkAndIncrement } from './throttle.js'
import { isEmailRetired, RETIRED_EMAIL_MESSAGE } from './deletedEmails.js'

// Login by e-mail code, shared by auth-verify-code and any form that logs a
// person in on the way (registration). Answers what the caller should send
// back; it never builds a Response. A database failure throws, and the caller
// answers 500.

const SESSION_MAX_AGE = 90 * 24 * 60 * 60 // 90 days in seconds

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra })

/**
 * @returns {Promise<
 *   { ok: true, profile: { id: string, username: string|null }, email: string, cookie: string } |
 *   { ok: false, status: number, error: string, code?: string, retryAfterSec?: number }
 * >}
 */
export async function verifyCodeAndOpenSession(supabaseAdmin, { email, code }) {
  if (!email || !code || !/^\d{6}$/.test(String(code).trim())) {
    return fail(400, 'Nieprawidłowe dane.')
  }

  const normalizedEmail = email.toLowerCase().trim()
  const trimmedCode = String(code).trim()
  const now = new Date().toISOString()

  // Guessing is bounded per address as well as per code: requesting a new code
  // resets the 3-attempt counter, so without this an attacker could keep
  // buying fresh guesses. auth-request-code is throttled; this step was not.
  // failOpen: an unavailable rate limiter must not strand someone mid-login;
  // the per-code attempt cap is what stops guessing. See _shared/throttle.js.
  const guessThrottle = await checkAndIncrement(supabaseAdmin, `verify:${normalizedEmail}`, 15, { failOpen: true })
  if (!guessThrottle.allowed) {
    return fail(429, 'Zbyt wiele prób. Spróbuj ponownie później.', { retryAfterSec: guessThrottle.retryAfterSec })
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
    return fail(400, 'Kod wygasł lub nie istnieje. Poproś o nowy.')
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
    return fail(403, 'Ten kod jest już nieaktualny. Poproś o nowy.')
  }

  const incomingHash = await sha256hex(trimmedCode)
  if (incomingHash !== claimedHash) {
    return fail(401, 'Nieprawidłowy kod.')
  }

  // The flip is the gate: two requests carrying the same code (a double
  // submit) both pass the attempt claim, and only the one whose UPDATE flips
  // `used` goes on. Unconditional, both opened a session, and both tried to
  // create the same new profile (profiles_email_key, a 500).
  const { data: consumed, error: useErr } = await supabaseAdmin.from('auth_codes')
    .update({ used: true }).eq('id', loginCode.id).eq('used', false).select('id')
  if (useErr) throw useErr
  if (!consumed?.length) {
    return fail(403, 'Ten kod jest już nieaktualny. Poproś o nowy.')
  }

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
      return fail(403, RETIRED_EMAIL_MESSAGE, { code: 'email_retired' })
    }
    const newId = crypto.randomUUID()
    const { data: newProfile, error: insertError } = await supabaseAdmin
      .from('profiles')
      .insert({ id: newId, email: normalizedEmail })
      .select('id, username')
      .single()
    if (insertError?.code === '23505') {
      // Created meanwhile by another login for this address: use that one.
      const { data: raced, error: reErr } = await supabaseAdmin
        .from('profiles').select('id, username').eq('email', normalizedEmail).single()
      if (reErr) throw reErr
      profile = raced
    } else {
      if (insertError) throw insertError
      profile = newProfile
    }
  }

  // Create session
  const sessionToken = randomToken()
  const sessionExpires = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString()

  const { error: sessionError } = await supabaseAdmin
    .from('auth_sessions')
    .insert({ id: sessionToken, user_id: profile.id, email: normalizedEmail, expires_at: sessionExpires })
  if (sessionError) throw sessionError

  const cookie = `leszy_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`

  return { ok: true, profile, email: normalizedEmail, cookie }
}
