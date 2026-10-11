// profiles.privacy_settings is jsonb that update-profile merged verbatim: only
// club_public_name was ever validated. Anything else the caller sent was stored
// as-is, and profiles_public casts three of these keys to boolean in SQL —
// `(privacy_settings ->> 'display_name')::boolean`. One string value therefore
// takes the user's own public page down with `22P02 invalid input syntax for
// type boolean`, which supabase-js returns as no data, which the page renders
// as "Nie znaleziono użytkownika" with nothing explaining why. The same row
// also poisons any bulk read of the view.

const BOOLEAN_FLAGS = ['display_name', 'club', 'bio', 'favorites']
const CLUB_PUBLIC_NAME_VALUES = ['display', 'nickname']

/**
 * @param incoming what the caller sent
 * @param current  what is stored today (merged onto, so a partial update does
 *                 not silently drop the other flags)
 * @returns {{ value: object }|{ error: string }}
 */
export function sanitizePrivacySettings(incoming, current) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { error: 'privacy_settings musi być obiektem.' }
  }

  const value = { ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}) }

  for (const [key, raw] of Object.entries(incoming)) {
    if (BOOLEAN_FLAGS.includes(key)) {
      if (typeof raw !== 'boolean') return { error: `privacy_settings.${key} musi być true albo false.` }
      value[key] = raw
      continue
    }
    if (key === 'club_public_name') {
      if (!CLUB_PUBLIC_NAME_VALUES.includes(raw)) {
        return { error: `privacy_settings.club_public_name musi być "display" albo "nickname".` }
      }
      value[key] = raw
      continue
    }
    return { error: `Nieznane ustawienie prywatności: ${key}.` }
  }

  return { value }
}
