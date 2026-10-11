// A rajd pieszy is a group walk along a route. It is not raced and not timed,
// so it is not a race a runner enters. Organizers register one on the same
// timing platforms as their races, and a scraper reads it as a running event:
// I PIESZY RAJD - KIERUNEK CHEŁMY reached calendar_events as `uliczny`.
//
// The evidence is the word pieszy, not the word rajd. A rajd is a route. On
// 2026-09-29 the stored rows held Rajd Górski Boguszowska 50, Rajd 12. SKOCKA
// 100, IV Rajd Izersko-Karkonoski at 120 km and every Rajd Nordic Walking, all
// of them raced. A rajd keyword would have destroyed the lot.
//
// maraton is not evidence against it either. It states a distance, and MARATON
// PIESZY „SUDECKI SOWIZDRZAŁ" and XXI Ekstremalny Maraton Pieszy KIERAT are
// both walked.

// Anchored at BOTH ends, unlike looksMultisport, where a compound name is the
// thing being caught. Here a compound name is the thing to avoid: Pieszyce is a
// town in the Sowie mountains and KORONA GÓR SOWICH PIESZYCE UPHILL is a
// running race held in it. The endings are the declensions the stored names
// show plus the others the same adjective takes.
const WALKED = /\bpiesz(?:y|a|e|o|ym|ej|ych|ymi|emu|ego)\b/i

// One name can carry both a race and a ramble, and then the race is what this
// calendar lists. bgtimesport 870 is "Bieg Górski Na Błatnią oraz Beskidzki
// Rajd Pieszy": a 9 km mountain race with a hike alongside it. The pieszo-
// biegowy festivals are the same shape.
//
// Nordic walking is walked and is kept anyway, because this calendar carries it
// as a first-class event type.
const RACED = /\bbieg|nordic\s*walking|\bnw\b|z\s+kijami/i

/**
 * True when the event is a walking rally rather than a race.
 *
 * The event NAME is the evidence. Most sources expose no discipline field, and
 * an organizer who runs a ramble says so in the name because it is what they
 * are inviting people to.
 *
 * @param {{name?: string}} [event]
 * @returns {boolean}
 */
export function looksWalkingRally({ name } = {}) {
  if (!name) return false
  if (RACED.test(name)) return false
  return WALKED.test(name)
}
