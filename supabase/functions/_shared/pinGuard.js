// Per-event PIN check with a lockout that survives instances and ignores who
// is asking. checkpoint-roster used to count attempts in an in-memory Map keyed
// on the first X-Forwarded-For hop, which the caller writes, so a 6-digit PIN
// fell to anyone who rotated that header.
//
// The lockout is per event and per PIN column, not per caller: there is no
// caller identity a forger cannot change. That means 30 wrong PINs in 15
// minutes lock the PIN for the volunteers and Pi agents too. Both queue their
// entries and retry on 429, so a lockout delays an entry and loses none.

export const PIN_FAILURE_LIMIT = 30
export const PIN_WINDOW_SECONDS = 15 * 60

/** @param {string} column event_secrets column, e.g. 'checkpoint_pin' */
function throttleKey(column, eventId) {
  return `pin:${column}:${eventId}`
}

/**
 * @param {import('https://esm.sh/@supabase/supabase-js@2').SupabaseClient} admin service-role client
 * @param {{ eventId: string, column: 'checkpoint_pin' | 'checkin_pin', pin: string }} p
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
export async function checkEventPin(admin, { eventId, column, pin }) {
  const key = throttleKey(column, eventId)

  const { data: window, error: winErr } = await admin
    .from('otp_throttle')
    .select('attempts, window_started_at')
    .eq('key', key)
    .maybeSingle()
  if (winErr) return { ok: false, status: 500, error: 'Lookup failed' }
  if (window && window.attempts >= PIN_FAILURE_LIMIT
      && Date.parse(window.window_started_at) > Date.now() - PIN_WINDOW_SECONDS * 1000) {
    return { ok: false, status: 429, error: 'Too many attempts' }
  }

  const { data: secret, error: secErr } = await admin
    .from('event_secrets').select(column).eq('event_id', eventId).maybeSingle()
  if (secErr) return { ok: false, status: 500, error: 'Lookup failed' }

  const expected = secret?.[column]
  if (expected && pin === expected) return { ok: true }

  // The write is the count (claim_throttle_slot is one UPSERT), so concurrent
  // wrong guesses cannot all read the same number and slip past.
  await admin.rpc('claim_throttle_slot', {
    p_key: key, p_limit: PIN_FAILURE_LIMIT, p_window_seconds: PIN_WINDOW_SECONDS,
  })
  return { ok: false, status: 401, error: 'Invalid PIN' }
}
