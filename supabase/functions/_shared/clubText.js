// ASCII slug rule shared with the /listy pages (public/src/lib/slugify.js POLISH_MAP).
const POLISH_MAP = {
  'ą':'a','ć':'c','ę':'e','ł':'l','ń':'n','ó':'o','ś':'s','ź':'z','ż':'z',
  'Ą':'a','Ć':'c','Ę':'e','Ł':'l','Ń':'n','Ó':'o','Ś':'s','Ź':'z','Ż':'z',
}

function fold(str) {
  return str.replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (ch) => POLISH_MAP[ch] || ch)
}

/** ASCII slug base for /klub/:slug (no date/id suffix). */
export function slugifyClub(name) {
  return fold(String(name).toLowerCase())
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Normalized display key for clubs.normalized_name (trigram search + uniqueness). */
export function normalizeClubName(name) {
  return fold(String(name).toLowerCase())
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
