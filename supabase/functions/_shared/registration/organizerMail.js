// Plan 6's organizer e-mails, sent so that nothing about the send can become a 500. Plain ESM, no
// runtime APIs: the caller passes the sender (sendEmail), so node tests run it with a fake one.
//
// SendGrid gets 10 s (SENDGRID_TIMEOUT_MS) and then throws with `deliveryUnknown: true`: the
// mail may have gone. An organizer action that already spent an allowance, or already wrote, must
// not answer 500 for that: the organizer would retry a thing that half happened.

/**
 * One send that never throws.
 * @param {() => Promise<{ ok: boolean, status?: number }>} send
 * @returns {Promise<{ ok: true } | { ok: false, unknown: boolean, status?: number }>}
 *   `unknown`: the send threw with `deliveryUnknown` (the timeout, a broken connection), so the
 *   mail may have been delivered. An HTTP refusal or any other error is `unknown: false`.
 */
export async function trySend(send) {
  try {
    const res = await send()
    if (res && res.ok === false) return { ok: false, unknown: false, status: res.status }
    return { ok: true }
  } catch (err) {
    console.error('organizer e-mail failed:', err?.message)
    return { ok: false, unknown: err?.deliveryUnknown === true }
  }
}

/**
 * An e-mail behind a one-statement allowance (claim_throttle_slot) that only a sent e-mail spends.
 * The slot is claimed before the send, so two clicks cannot both send, and given back when the
 * send did not go out, a timeout included (the organizer is told to try again, so the slot must be
 * there; a second copy after a timeout is the lesser harm than a reminder nobody can resend for a
 * day). A release that fails is logged: the organizer then waits out the window, nothing worse.
 * @param {{ claim: () => Promise<{ allowed: boolean, retryAfterSec?: number }>,
 *   release: () => Promise<void>, send: () => Promise<{ ok: boolean, status?: number }> }} steps
 * @returns {Promise<{ sent: true } | { throttled: number } | { failed: true, unknown: boolean }>}
 */
export async function sendOnAllowance({ claim, release, send }) {
  const slot = await claim()
  if (!slot.allowed) return { throttled: slot.retryAfterSec ?? 60 }
  const out = await trySend(send)
  if (out.ok) return { sent: true }
  try {
    await release()
  } catch (err) {
    console.error('organizer e-mail: allowance not given back:', err?.message)
  }
  return { failed: true, unknown: out.unknown }
}

/** release_throttle_slot as a sendOnAllowance `release`: an RPC error is thrown, so it is logged. */
export function releaseSlot(admin, key) {
  return async () => {
    const { error } = await admin.rpc('release_throttle_slot', { p_key: key })
    if (error) throw error
  }
}
