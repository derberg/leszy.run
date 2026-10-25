// What the account menu in the navbar shows next to its shortcuts. Pure, so the
// counting and the link rules are tested without a browser.

// Anchor of the "starts the clubmates follow" section in the club panel, which
// the menu's "Starty klubowiczów" shortcut jumps to.
export const CLUB_STARTS_ANCHOR = 'starty-klubowiczow'

/**
 * Starred events still ahead of the user, and the nearest one. A cancelled
 * start is not one to go to, so it counts for neither.
 * @param {{ name: string, date: string|null, status?: string }[]|undefined} events
 * @param {string} today YYYY-MM-DD
 */
export function upcomingStarts(events, today) {
  const ahead = (events ?? [])
    .filter((e) => e?.date && e.date.slice(0, 10) >= today && e.status !== 'cancelled')
    .sort((a, b) => a.date.localeCompare(b.date))
  return { count: ahead.length, next: ahead[0] ?? null }
}

/**
 * Where "Mój klub" and "Starty klubowiczów" lead for this user. A user cached
 * before auth-me returned the club slug knows only the club's id and name, so
 * both fall back to the club hub in the profile until the cache refreshes.
 * @param {{ club_id?: string|null, club?: string|null, club_slug?: string|null }|null} user
 */
export function clubLinks(user) {
  if (!user?.club_id) return { hasClub: false, name: null, club: '/profil/klub', starts: '/profil/klub' }
  if (!user.club_slug) return { hasClub: true, name: user.club ?? null, club: '/profil/klub', starts: '/profil/klub' }
  const panel = `/klub/${user.club_slug}/panel`
  return { hasClub: true, name: user.club ?? null, club: panel, starts: `${panel}#${CLUB_STARTS_ANCHOR}` }
}

/** "11.11" for the nearest start's line in the menu. */
export function shortDate(date) {
  const [, m, d] = (date ?? '').slice(0, 10).split('-')
  return d && m ? `${d}.${m}` : ''
}
