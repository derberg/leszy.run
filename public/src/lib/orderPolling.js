// How often the order page (/zamowienie/:orderId) asks order-status while an
// order waits for its payment. order-status allows 120 reads per order and
// hour, and each read may ask dpay too, so: a few quick reads right after the
// return from dpay (the IPN usually lands within seconds), then backing off to
// one a minute, and nothing after POLL_WINDOW_MS (the page then offers
// „Sprawdź ponownie”). Over a page's lifetime that is well under one read per
// 30 s on average, so even two page loads in one hour stay under the throttle.

const QUICK = [3000, 5000, 10_000, 15_000, 30_000]
const SLOW = 60_000
export const POLL_WINDOW_MS = 20 * 60 * 1000

/**
 * The wait before read n (1 = the read after the first), or null once the
 * window is spent. A 429 waits at least the server's Retry-After.
 * @param {number} n
 * @param {{ retryAfterSec?: number }} [opts]
 */
export function pollDelayMs(n, { retryAfterSec } = {}) {
  let elapsed = 0
  for (let i = 1; i < n; i++) elapsed += QUICK[i - 1] ?? SLOW
  const base = QUICK[n - 1] ?? SLOW
  if (elapsed + base > POLL_WINDOW_MS) return null
  return Math.max(base, (retryAfterSec ?? 0) * 1000)
}
