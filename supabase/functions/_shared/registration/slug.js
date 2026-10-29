// Slugs for /events/:slug. ASCII, lowercase, '-' separated, 3-80 characters.
// Plain ESM, no runtime APIs: runs in Deno and Node.

export const SLUG_MIN = 3
export const SLUG_MAX = 80
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// "ł" and "Ł" have no canonical decomposition, so NFD alone does not cover them.
const EXTRA = { 'ł': 'l', 'Ł': 'L' }

export function slugify(name) {
  const ascii = String(name ?? '')
    .replace(/[łŁ]/g, (c) => EXTRA[c])
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return ascii.slice(0, SLUG_MAX).replace(/-+$/g, '')
}

export function isValidSlug(s) {
  return typeof s === 'string' && s.length >= SLUG_MIN && s.length <= SLUG_MAX && SLUG_RE.test(s)
}

/** The public event page of a registration event. */
export function eventPageUrl(slug) {
  return `https://www.leszy.run/events/${slug}`
}
