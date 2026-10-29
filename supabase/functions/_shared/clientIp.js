// The caller's IP, for rate limits and audit rows. One parser for every function that keys a
// limit on it (auth-request-code, consent-request, register-free, create-order) or stores it
// (organizer_actions, consent_acceptances: inet columns).
//
// The FIRST x-forwarded-for element, deliberately, even though a direct caller can forge it.
// Browser traffic does not reach the functions directly: it goes through the same-origin /edge
// rewrite in public/vercel.json, so the chain that arrives here is [browser, vercel-egress] and
// Cloudflare's cf-connecting-ip is Vercel's egress address. Keying on either of those collapses
// every user of the site onto one or two shared addresses, and then one person with 21 different
// email addresses (the per-email cap of 5 never fires) exhausts the 20-per-IP budget and locks
// EVERYONE out of login for the rest of the window. A cap that an attacker can evade for
// themselves is a far smaller problem than one they can trip for everybody, so this reads the
// originating element and accepts the spoofing. The per-email cap and the per-code attempt cap
// are what actually bound abuse.
//
// An element that is not an IP gives null: the caller then skips its per-IP limit (as for a
// missing header) rather than keying a counter on arbitrary text.

const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+)$/

/** First x-forwarded-for element, or null when empty or not an IP. */
export function clientIp(req) {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
  return ip && IP_RE.test(ip) && (ip.includes('.') || ip.includes(':')) ? ip : null
}
