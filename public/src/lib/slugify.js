const POLISH_MAP = {
  'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n',
  'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
  'Ą': 'a', 'Ć': 'c', 'Ę': 'e', 'Ł': 'l', 'Ń': 'n',
  'Ó': 'o', 'Ś': 's', 'Ź': 'z', 'Ż': 'z',
}

/**
 * Generate a URL-safe slug from event name and date.
 * @param {string} name - Event name
 * @param {string} date - ISO date string (YYYY-MM-DD)
 * @param {string} [id] - Optional event ID for dedup suffix
 * @returns {string} slug like "bieg-7-szczytow-ultra-trail-2026-07-12"
 */
export function slugify(name, date, id) {
  const base = name
    .toLowerCase()
    .replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, ch => POLISH_MAP[ch] || ch)
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  const dateStr = date.slice(0, 10) // YYYY-MM-DD
  const slug = `${base}-${dateStr}`

  return id ? `${slug}-${id.slice(0, 4)}` : slug
}

/**
 * Extract the date portion from a slug (last 10 chars before optional ID suffix).
 * @param {string} slug
 * @returns {string|null} ISO date string or null
 */
export function extractDateFromSlug(slug) {
  // Match YYYY-MM-DD pattern anywhere in slug
  const match = slug.match(/(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : null
}
