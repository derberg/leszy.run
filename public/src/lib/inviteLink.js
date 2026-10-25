// Club invite links: /klub/<slug>/dolacz?kod=<code>.
//
// The login and onboarding pages only know where they will send the visitor
// next (?from=). These helpers let them recognise that the next stop is an
// invite, so they can say which club is waiting instead of a bare login form.

const INVITE_PATH_RE = /^\/klub\/([^/?#]+)\/dolacz$/

/** The address a manager shares. */
export function inviteUrl(origin, slug, code) {
  return `${origin}/klub/${slug}/dolacz?kod=${code}`
}

/** @returns {{ slug: string, code: string } | null} */
export function inviteFromPath(path) {
  if (typeof path !== 'string') return null
  const [pathname, query = ''] = path.split('?', 2)
  const match = INVITE_PATH_RE.exec(pathname)
  if (!match) return null
  const code = new URLSearchParams(query).get('kod')
  if (!code) return null
  return { slug: decodeURIComponent(match[1]), code }
}

/**
 * Where a visitor goes after a successful login. Someone with no username has
 * never been through onboarding, which is where the regulamin and the privacy
 * policy are accepted, so they go there first even when a `from` is waiting,
 * and onboarding forwards them on. A `from` used to win outright, so a new
 * account that started at an invite link joined the club without a username
 * and without having accepted the terms.
 */
export function postAuthPath({ from, hasUsername }) {
  if (hasUsername) return from || '/profil'
  return from ? `/onboarding?from=${encodeURIComponent(from)}` : '/onboarding'
}
