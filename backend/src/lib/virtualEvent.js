// Races that are run virtually: the entrant runs the distance alone, anywhere,
// and uploads a time from a watch. This calendar lists races a runner travels
// to, so a virtual entry has no start line, no city and no course to publish.

// The Polish stem covers wirtualny, wirtualna, wirtualnie and wirtualnych. The
// English form is matched as a whole word only, so a brand such as VirtualGym
// is left alone. "Zdalny" is not on the list: it is used for remote work and
// remote timing, never for the race format.
const VIRTUAL = /\bwirtualn|\bvirtual\b/i

// An event that sells both a virtual and an on-site entry. The on-site edition
// has a real start line, so the row belongs in the calendar.
const ON_SITE_TOO = /\bstacjonarn/i

/**
 * True when the event is run virtually and has no on-site edition.
 *
 * The event NAME is the evidence, which is the opposite of looksNonPolish().
 * A virtual race declares the format in its name because that is what the
 * organizer is selling, and the location field cannot be trusted to say it:
 * the nine virtual rows in scraper_all carry "Cała Polska", "Świat", "Polska",
 * "Cały świat" and also plain city names such as Gdynia and Piastów.
 */
export function looksVirtual({ name } = {}) {
  if (!name) return false
  if (ON_SITE_TOO.test(name)) return false
  return VIRTUAL.test(name)
}
