// Is this URL the front door of a registration platform rather than one event?
//
// WHY THIS IS NOT CAUGHT BY A RELEVANCE CHECK
// Every gate we have asks the same question: does the fetched page mention this
// event? A platform homepage answers yes. https://zapisy.info/ lists its
// upcoming races by name, so "VII Bieg Pocztyliona" is on it, and the URL was
// stored. The race's own page, https://zapisy.info/imprezy/718/, is where the
// registration window lives, and nothing ever reached it. The homepage passes
// the check for every event the platform runs, which is precisely why it is
// worthless as one event's registration_url.
//
// The hosts below are the platforms this project already scrapes, taken from
// backend/src/scrapers/sources/. Being a scraper source is what makes a host a
// platform: it serves many races under paths, so its root is a directory, not a
// race. An organizer's own domain is deliberately absent — https://naszadycha.pl
// with an empty path is that race's site and a fine registration_url.
//
// Matching is on the exact host (www. stripped), never a parent domain: some
// platforms give a race its own subdomain, where the root IS the event
// (5.biegnijmy.pl, h2opolmaraton.pro-run.pl).
//
// enricher/enricher/steps/platforms.py holds the same list for the Python
// enricher. Keep the two in step.
export const REGISTRATION_PLATFORM_HOSTS = new Set([
  'aleczas.pl',
  'b4sportonline.pl',
  'bgtimesport.pl',
  'biegiwpolsce.pl',
  'biegnijmy.pl',
  'competitions.timekeeper.pl',
  'czasomierzyk.pl',
  'datasport.pl',
  'dostartu.pl',
  'e-gepard.eu',
  'elektronicznezapisy.pl',
  'formularz.czasomierzyk.pl',
  'foxter-sport.pl',
  'herkules.org.pl',
  'kepasport.pl',
  'liveds.datasport.pl',
  'lumisport.eu',
  'maratonczykpomiarczasu.pl',
  'maratonypolskie.pl',
  'motivato.pl',
  'online.datasport.pl',
  'pifsport.com.pl',
  'plus-timing.pl',
  'pomiarczasuatelier.pl',
  'pomiaryczasu.pl',
  'protiming24.pl',
  'rajsportactive.pl',
  'sport-time.com.pl',
  'super-sport.com.pl',
  'superczas.pl',
  'time-sport.pl',
  'timekeeper.pl',
  'timing4u.pl',
  'wbtiming.pl',
  'wyniki.plus-timing.pl',
  'zapisy.inessport.pl',
  'zapisy.info',
  'zapisy.raatiming.pl',
  'zapisyonline.pl',
  'zapisyvaldano.pl',
  'zmierzymyczas.pl',
])

// Query keys that carry no event identity — a share link picks these up on the
// way from Facebook, and the URL underneath is still the bare homepage.
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'brid', 'mc_cid', 'mc_eid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
])

export function isPlatformRootUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url).trim())
  } catch {
    return false
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  if (!REGISTRATION_PLATFORM_HOSTS.has(host)) return false

  // A fragment addresses one entry in the platform's list (inessport's #gr291),
  // so the URL still points at an event.
  if (parsed.hash) return false

  if (parsed.pathname.replace(/\/+$/, '') !== '') return false

  for (const key of parsed.searchParams.keys()) {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) return false
  }

  return true
}
