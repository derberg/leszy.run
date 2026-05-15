import { fetchCompetition, fetchClassifications, parseClassifications } from './sources/dostartu.js'

// Domains that share the dostartu API (same -v{id} URL pattern, same api.dostartu.pl).
// Note: zapisy.mktime.pl and zapisy.o-timing.pl use the same -v{id} URL scheme as dostartu.
const DOSTARTU_LIKE_DOMAINS = [
  'dostartu.pl',
  'zapisy.mktime.pl',
  'zapisy.o-timing.pl',
]

function isDostartuLikeUrl(url) {
  if (!url) return false
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return DOSTARTU_LIKE_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`))
  } catch {
    return false
  }
}

// Extract numeric competition ID from a dostartu-like URL.
// Handles: /permalink-v123, /some-slug-v123, /zawody/123
function extractDostartuId(url) {
  if (!url) return null
  const vMatch = url.match(/-v(\d+)(?:[/?#]|$)/)
  if (vMatch) return vMatch[1]
  const zawodyMatch = url.match(/\/zawody\/(\d+)/)
  if (zawodyMatch) return zawodyMatch[1]
  return null
}

// Enrich an event if its registration_url points to a known API-backed platform.
// Never overwrites fields the scraper already set — only fills nulls.
// Skip if price and deadline are already populated (avoids redundant API calls).
async function enrichFromUrl(event) {
  if (!isDostartuLikeUrl(event.registration_url)) return event

  if (event.price_from != null && event.registration_deadline) return event

  const id = extractDostartuId(event.registration_url)
  if (!id) return event

  const [comp, classifications] = await Promise.all([
    fetchCompetition(id),
    fetchClassifications(id),
  ])

  const { distances, isKids, priceFrom, priceTo, latestEndedTime } =
    parseClassifications(classifications, event.name)

  const deadlineIso = latestEndedTime || comp?.provisionTime || comp?.endDate
  const registration_deadline = deadlineIso ? deadlineIso.split('T')[0] : null
  const regulamin_url = comp?.statuteLinkPl || comp?.statuteFilePl || null
  const website = comp?.websitePl || null
  const location = comp?.location || null
  const lat = comp?.locationLat ?? null
  const lng = comp?.locationLng ?? null

  return {
    ...event,
    // Only fill location/coords if the scraper didn't get them
    location: event.location || location,
    lat: event.lat ?? lat,
    lng: event.lng ?? lng,
    // Prefer scraper distances when richer; API distances are a fallback
    distances: event.distances || distances,
    is_kids: event.is_kids || isKids,
    price_from: event.price_from ?? priceFrom,
    price_to: event.price_to ?? priceTo,
    registration_deadline: event.registration_deadline || registration_deadline,
    regulamin_url: event.regulamin_url || regulamin_url,
    website: event.website || website,
  }
}

export { isDostartuLikeUrl, extractDostartuId, enrichFromUrl }
