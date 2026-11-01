// The caller's IP, for rate limits and audit rows. This module is the only place in the edge
// functions that reads an IP header (a unit test fails on any other file that does).
//
// What arrives, and who wrote each part:
//   - A browser on www.leszy.run goes through the /edge rewrite in public/vercel.json. Vercel
//     OVERWRITES x-forwarded-for with the browser's address ("we overwrite the X-Forwarded-For
//     header and do not forward external IPs", vercel.com/docs/headers/request-headers), then
//     Supabase's Cloudflare front appends Vercel's egress address and sets cf-connecting-ip to it.
//     Chain: [browser, vercel-egress], peer = vercel-egress.
//   - Anything can also call <project>.supabase.co/functions/v1/* directly, with no Origin, so
//     guardRequest lets it through. Every x-forwarded-for element it sends is its own; Cloudflare
//     appends the real address and sets cf-connecting-ip (observed on this platform:
//     "x-forwarded-for: spoofed,68.65.164.215" with "cf-connecting-ip: 68.65.164.215",
//     github.com/orgs/supabase/discussions/34647). Chain: [anything…, caller], peer = caller.
//     The local stack's Kong does the same: it appends the peer and sets x-real-ip.
//
// So the peer (cf-connecting-ip, else the right-most element) is the one address no caller can
// choose. It is NOT the browser on the /edge path: there it is Vercel, shared by every user of the
// site. The browser's address is the element left of the peer, which Vercel vouches for on the
// /edge path and which a direct caller forges at will. No header separates the two paths (a direct
// caller can send x-vercel-* too), so there is no unforgeable per-browser address. Hence two
// counters for every per-IP limit (`ipThrottles`):
//   - per client (`clientIp`): the old limit, per browser. A direct caller can rotate it.
//   - per peer (`peerIp`): a higher limit nobody can rotate. For a direct caller it caps them
//     whatever they forge; for the /edge path it is a site-wide ceiling on browser traffic, so it
//     is set well above real traffic and an attacker would have to push that many requests through
//     /edge (where each of their own addresses is held to the per-client limit) to reach it.
// Reading the LEFT-most element, as this did until 2026-11-01, let a direct caller reset every
// per-IP limit with a fresh fake value per request.
//
// A missing address never skips a limit: it counts in the shared `unknown` bucket.

const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+)$/
const isIp = (s) => !!s && IP_RE.test(s) && (s.includes('.') || s.includes(':'))

const forwardedList = (req) =>
  (req.headers.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean)

/** The address the platform connected from: cf-connecting-ip, else the right-most x-forwarded-for element. Unforgeable. */
export function peerIp(req) {
  const cf = (req.headers.get('cf-connecting-ip') || '').trim()
  if (isIp(cf)) return cf
  const last = forwardedList(req).at(-1)
  return isIp(last) ? last : null
}

/**
 * The best per-client address: the element the proxy in front of the peer vouched for (the browser
 * behind /edge), else the peer itself. Forgeable by a caller that skips /edge, so every limit keyed
 * on it is paired with a per-peer one (`ipThrottles`). Also what audit rows store.
 */
export function clientIp(req) {
  const peer = peerIp(req)
  const list = forwardedList(req)
  const at = peer ? list.lastIndexOf(peer) : -1
  const left = at > 0 ? list[at - 1] : null
  return isIp(left) ? left : peer
}

/**
 * The `{ key, limit, windowSeconds }` pair for a per-IP limit, for checkAndIncrement / prepareRegistration:
 * `<prefix>:<clientIp>` at `limit` and `<prefix>-peer:<peerIp>` at `peerLimit`. Never empty.
 */
export function ipThrottles(req, prefix, { limit, peerLimit, windowSeconds }) {
  return [
    { key: `${prefix}:${clientIp(req) ?? 'unknown'}`, limit, windowSeconds },
    { key: `${prefix}-peer:${peerIp(req) ?? 'unknown'}`, limit: peerLimit, windowSeconds },
  ]
}
