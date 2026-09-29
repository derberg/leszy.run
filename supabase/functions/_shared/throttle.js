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
    // Fail OPEN, loudly. Failing closed sounds safer until you notice what it
    // does: this function now gates both auth-request-code and
    // auth-verify-code, so one unavailable RPC — a PostgREST schema cache that
    // has not caught up with a fresh migration, a pool timeout — locks every
    // user out of logging in, and tells them "too many attempts", which sends
    // whoever debugs it looking in the wrong place entirely. A rate limit is
    // not an authorisation check: while it is down, the per-code 3-attempt cap
    // (atomic, in the same migration) still bounds guessing.
    console.error('throttle: claim_throttle_slot unavailable, allowing request:', error.message)
    return { allowed: true }
  }
  const row = Array.isArray(data) ? data[0] : data
  if (row?.allowed) return { allowed: true }
  return { allowed: false, retryAfterSec: row?.retry_after_sec ?? 60 }
}
