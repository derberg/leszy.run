// Multisport races: triathlon, duathlon, aquathlon. They contain a running leg,
// so an organizer files them on a running platform and a scraper reads them as
// running events. This calendar lists races a runner enters as a runner.

// No leading \b. The merge's SKIP_KEYWORDS carried \btriathlon\b, \bduathlon\b
// and \baquathlon\b, and a \b needs a non-word character in front, which a
// compound name does not provide: CROSSDUATHLON LASKI 2026 reached
// calendar_events as `trail`, and Paratriathlon Kraina Liwca the same way.
// Prefixes seen in the corpus are CROSS- and PARA-, but the list of things an
// organizer can glue on the front is open, so the prefix is not enumerated.
//
// Both spellings of each: Polish drops the h (duatlon, triatlon) and writes
// aqua as akwa. The prefixes stop one letter short (aqu, akw) because the a
// belongs to the -athlon half: aquathlon splits as aqu + athlon.
//
// biathlon and pentathlon are deliberately absent: neither has appeared, and
// -athlon alone would match them along with anything else ending that way.
const MULTISPORT = /(?:du|tri|aqu|akw)(?:ath|at)lon/i

// A run&bike is entered as a running race with a bike leg, and its running leg
// is timed on its own. mergeIntoScraperAll already exempted these from
// SKIP_KEYWORDS via isRunBike; the same exemption is kept here so moving the
// check into this module changes no verdict for them.
const RUN_BIKE = /\brun\s*&?\s*bike\b|biegowo[- ]?rowerow/i

/**
 * True when the event is a multisport race rather than a running race.
 *
 * The event NAME is the evidence. These races declare the discipline in the
 * name because it is what the organizer sells, and most sources expose no
 * discipline field for the merge to gate on.
 */
export function looksMultisport({ name } = {}) {
  if (!name) return false
  if (RUN_BIKE.test(name)) return false
  return MULTISPORT.test(name)
}
