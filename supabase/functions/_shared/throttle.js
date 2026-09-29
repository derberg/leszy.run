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
 * write — see claim_throttle_slot in migration 20260929230000.
 *
 * `failOpen` says what to do when the RPC itself is unavailable — a PostgREST
 * schema cache lagging a fresh migration, a pool timeout. It is not one answer
 * for both callers:
 *   - verifying a code: fail OPEN. A 429 there strands someone mid-login and
 *     tells them they made too many attempts, which sends whoever debugs it
 *     looking in the wrong place. Guessing is still capped per code by
 *     claim_auth_code_attempt.
 *   - requesting a code: fail CLOSED. That path sends mail to any address the
 *     caller names, so running it unthrottled lets one person mail thousands of
 *     login codes to a third party and burn the sending domain's reputation.
 *     The cost of being wrong is "you cannot start a new login for a few
 *     minutes"; existing sessions are untouched.
 *
 * @returns {Promise<{ allowed: boolean, retryAfterSec?: number }>}
 */
export async function checkAndIncrement(supabaseAdmin, key, limit, { failOpen = false } = {}) {
  const { data, error } = await supabaseAdmin.rpc('claim_throttle_slot', {
    p_key: key,
    p_limit: limit,
    p_window_seconds: WINDOW_SECONDS,
  })
  if (error) {
    console.error(`throttle: claim_throttle_slot unavailable for ${key}, ${failOpen ? 'allowing' : 'refusing'}:`, error.message)
    return failOpen ? { allowed: true } : { allowed: false, retryAfterSec: 60 }
  }
  const row = Array.isArray(data) ? data[0] : data
  if (row?.allowed) return { allowed: true }
  return { allowed: false, retryAfterSec: row?.retry_after_sec ?? 60 }
}
