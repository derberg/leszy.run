// What create-club and update-club accept for a club's own fields. Both used
// to store description, city and voivodeship as sent: any length, any type, a
// voivodeship nobody can filter by, and an is_public that could be a string.
// Plain ESM, no Deno APIs (node tests import it).

export const CLUB_NAME_MIN = 2
export const CLUB_NAME_MAX = 100
export const CLUB_DESCRIPTION_MAX = 2000
export const CLUB_CITY_MAX = 100
export const CLUB_WEBSITE_MAX = 500
export const CLUB_WEBSITE_ERROR = 'Podaj adres zaczynający się od http:// albo https://.'

// The values stored in scraper_all / calendar_events, capitalised; the same
// list as REGION_SLUG_TO_DB in public/src/lib/biegi-mappings.js.
export const VOIVODESHIPS = [
  'Dolnośląskie', 'Kujawsko-Pomorskie', 'Lubelskie', 'Lubuskie', 'Łódzkie',
  'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-Mazurskie',
  'Wielkopolskie', 'Zachodniopomorskie',
]

export const CLUB_NAME_ERROR = `Nazwa klubu jest wymagana (${CLUB_NAME_MIN}–${CLUB_NAME_MAX} znaków).`

/** null when the trimmed name is acceptable, else the error message. */
export function clubNameError(trimmed) {
  if (typeof trimmed !== 'string' || trimmed.length < CLUB_NAME_MIN || trimmed.length > CLUB_NAME_MAX) {
    return CLUB_NAME_ERROR
  }
  return null
}

/**
 * The club's own website (clubs.website_url), shown as the organizer's link on its events'
 * pages: trimmed, '' and null clear it. The same rule as the column CHECK and as an event's
 * website_url (rules.webUrl in _shared/registration/sections.js).
 * @returns {{ value: string|null }|{ error: string }}
 */
export function clubWebsite(v) {
  if (v === null || v === '') return { value: null }
  if (typeof v !== 'string') return { error: CLUB_WEBSITE_ERROR }
  const t = v.trim()
  if (!t) return { value: null }
  if (t.length > CLUB_WEBSITE_MAX || !/^https?:\/\/\S+$/i.test(t)) return { error: CLUB_WEBSITE_ERROR }
  try {
    const u = new URL(t)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname ? { value: t } : { error: CLUB_WEBSITE_ERROR }
  } catch {
    return { error: CLUB_WEBSITE_ERROR }
  }
}

/**
 * Checks the optional fields a request carries; a field that is undefined is
 * not being set and is not checked. null clears description, city and
 * voivodeship ('' for voivodeship too: callers store it as null).
 *
 * @param {{ description?: unknown, city?: unknown, voivodeship?: unknown, is_public?: unknown }} fields
 * @returns {string|null} the error message, or null when every given field is valid
 */
export function clubFieldsError({ description, city, voivodeship, is_public } = {}) {
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string') return 'Opis klubu musi być tekstem.'
    if (description.length > CLUB_DESCRIPTION_MAX) return `Opis klubu może mieć najwyżej ${CLUB_DESCRIPTION_MAX} znaków.`
  }
  if (city !== undefined && city !== null) {
    if (typeof city !== 'string') return 'Miejscowość musi być tekstem.'
    if (city.length > CLUB_CITY_MAX) return `Miejscowość może mieć najwyżej ${CLUB_CITY_MAX} znaków.`
  }
  if (voivodeship !== undefined && voivodeship !== null && voivodeship !== '' && !VOIVODESHIPS.includes(voivodeship)) {
    return 'Nieprawidłowe województwo.'
  }
  if (is_public !== undefined && typeof is_public !== 'boolean') {
    return 'is_public musi być wartością logiczną.'
  }
  return null
}
