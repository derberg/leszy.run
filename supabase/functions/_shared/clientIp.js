// The caller's IP, for rate limits and audit rows. This module is the only place in the edge
// functions that reads an IP header (tests/registration/unit/clientIp.test.js fails on any other).
//
// What arrives, and who wrote each part:
//   - A browser on www.leszy.run goes through the /edge route in public/vercel.json. Vercel
//     OVERWRITES x-forwarded-for with the browser's address (vercel.com/docs/headers/request-headers),
//     the route sets x-leszy-edge to the Vercel env EDGE_PROXY_SECRET (after deleting any value the
//     client sent), and Supabase's Cloudflare front appends Vercel's egress address and sets
//     cf-connecting-ip to it. Chain: [browser, vercel-egress].
//   - Anything can also call <project>.supabase.co/functions/v1/* directly, with no Origin, so
//     guardRequest lets it through. Every x-forwarded-for element it sends is its own; Cloudflare
//     appends the real address and sets cf-connecting-ip ("x-forwarded-for: spoofed,68.65.164.215"
//     with "cf-connecting-ip: 68.65.164.215", github.com/orgs/supabase/discussions/34647). The local
//     stack's Kong does the same.
//
// So the browser address is trusted only when x-leszy-edge equals EDGE_PROXY_SECRET (constant time):
// then it is the element Vercel set, left of the peer. Otherwise the caller skipped Vercel and is
// keyed on the peer (cf-connecting-ip, else the right-most element), which it cannot choose. Reading
// the LEFT-most element unconditionally let a direct caller reset every per-IP limit with a fresh
// fake value per request.
//
// Until EDGE_PROXY_SECRET is set in the function secrets this reads the left-most element, exactly as
// before: switching on the peer while the /edge route sends no secret would put every browser into
// Vercel's few egress addresses. Set the Vercel env var first, redeploy, then the Supabase secret.
import { sameSecret } from './sameSecret.js'

export const EDGE_HEADER = 'x-leszy-edge'

const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+)$/
const isIp = (s) => !!s && IP_RE.test(s) && (s.includes('.') || s.includes(':'))
const list = (req, name) => (req.headers.get(name) || '').split(',').map((s) => s.trim()).filter(Boolean)
const configuredSecret = () => globalThis.Deno?.env?.get('EDGE_PROXY_SECRET') ?? ''

/** The address the platform connected from: cf-connecting-ip, else the right-most x-forwarded-for element. */
export function peerIp(req) {
  const cf = (req.headers.get('cf-connecting-ip') || '').trim()
  if (isIp(cf)) return cf
  const last = list(req, 'x-forwarded-for').at(-1)
  return isIp(last) ? last : null
}

/** The browser address the /edge route vouched for: the element left of the peer, else x-vercel-forwarded-for. */
function proxiedIp(req) {
  const peer = peerIp(req)
  const xff = list(req, 'x-forwarded-for')
  const at = peer ? xff.lastIndexOf(peer) : -1
  if (at > 0 && isIp(xff[at - 1])) return xff[at - 1]
  const vercel = list(req, 'x-vercel-forwarded-for')[0]
  return isIp(vercel) ? vercel : null
}

/**
 * The caller's address, or null when there is none. Per-IP limits key on `clientIp(req) ?? 'unknown'`
 * (a missing address is a shared bucket, never a skipped limit).
 * @param {{ headers: { get(name: string): string|null } }} req
 * @param {{ secret?: string }} [opts] the EDGE_PROXY_SECRET to compare with (tests); default the function secret.
 */
export async function clientIp(req, { secret = configuredSecret() } = {}) {
  if (!secret) {
    const first = list(req, 'x-forwarded-for')[0]
    return isIp(first) ? first : null
  }
  if (await sameSecret(req.headers.get(EDGE_HEADER), secret)) return proxiedIp(req) ?? peerIp(req)
  return peerIp(req)
}
