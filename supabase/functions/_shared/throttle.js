const WINDOW_SECONDS = 15 * 60

/**
 * Check + increment a counter under a key, in one statement.
 *
 * The previous version SELECTed the row, decided, and wrote in a separate
 * statement — and its own doc comment called that atomic. It was not: a burst
 * of concurrent first requests all read "no row", all inserted, all collided on
 * the primary key (the insert's error was discarded), and all returned allowed
 * while the counter stayed at 1. The cap that is supposed to stop someone
 * mailing 50 login codes at an address they do not own did nothing under
 * exactly the conditions it exists for. The decision now happens inside the
 * write — see claim_throttle_slot in migration 20260929200000.
 *
 * @returns {Promise<{ allowed: boolean, retryAfterSec?: number }>}
 */
export async function checkAndIncrement(supabaseAdmin, key, limit) {
  const { data, error } = await supabaseAdmin.rpc('claim_throttle_slot', {
    p_key: key,
    p_limit: limit,
    p_window_seconds: WINDOW_SECONDS,
  })
  if (error) {
    // Fail closed: a throttle that errors open is not a throttle. The caller
    // turns this into a 429, which is the safe answer for the login form.
    console.error('throttle: claim_throttle_slot failed:', error.message)
    return { allowed: false, retryAfterSec: 60 }
  }
  const row = Array.isArray(data) ? data[0] : data
  if (row?.allowed) return { allowed: true }
  return { allowed: false, retryAfterSec: row?.retry_after_sec ?? 60 }
}
