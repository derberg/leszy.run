// Shape caps for the free-text profile fields update-profile writes. Nothing
// bounded them: any JSON value of any size went straight into the row and out
// again on every public profile read. avatar_url is no longer sent by the app
// (avatars are emoji since #314), but the column is still writable, so it is
// held to what an <img src> on our pages may safely point at.

export const DISPLAY_NAME_MAX = 80
export const BIO_MAX = 1000
export const AVATAR_URL_MAX = 500

const isHttpsUrl = (s) => {
  try {
    return new URL(s).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * @param {{ display_name?: unknown, bio?: unknown, avatar_url?: unknown }} body
 * @returns {string|null} the error to answer 400 with, or null when the fields present are fine.
 */
export function profileFieldsError({ display_name, bio, avatar_url }) {
  if (display_name !== undefined && display_name !== null) {
    if (typeof display_name !== 'string' || display_name.length > DISPLAY_NAME_MAX) {
      return `Nazwa wyświetlana może mieć maksymalnie ${DISPLAY_NAME_MAX} znaków.`
    }
  }
  if (bio !== undefined && bio !== null) {
    if (typeof bio !== 'string' || bio.length > BIO_MAX) {
      return `Opis może mieć maksymalnie ${BIO_MAX} znaków.`
    }
  }
  if (avatar_url !== undefined && avatar_url !== null) {
    if (typeof avatar_url !== 'string' || avatar_url.length > AVATAR_URL_MAX
      || !avatar_url.startsWith('https://') || !isHttpsUrl(avatar_url)) {
      return 'Nieprawidłowy adres awatara.'
    }
  }
  return null
}
