// Herkules — Pomiar Czasu. Timing company, Pomorskie/Zachodniopomorskie-heavy,
// with scattered events across PL (NW Puchar Polski rounds in Dolnośląskie,
// Wielkopolskie, Podlaskie). ~18 future events.
//
// Data source: "The Events Calendar" (Tribe) plugin REST API:
//   https://herkules.org.pl/wp-json/tribe/events/v1/events?per_page=50&start_date=<today>
// Cleaner than the iCal feed — gives structured venue (city), event categories
// (Bieganie / Nordic Walking / Bieganie z przeszkodami / SUP / MTB / Kolarstwo /
// Triathlon), and a `website` field that is the real external registration URL.
//
// Registration: the `website` field points OUT to the registration platform the
// timing co uses — almost always b4sportonline.pl/<slug>/, sometimes inws.info
// (Nordic Walking federation). Verified 2026-06-01: b4sportonline.pl/biegibytow/
// returns 200 with event-specific content (Gochów / Półmaraton / Bytów / Zapisy);
// inws.info/ 301s to an event-relevant NW page. So website == registration_url.
//
// Distances / prices: NOT in the API (cost is empty). Left to the Python enricher,
// which crawls the b4sport registration page.
//
// Voivodeship: NOT emitted. The venue region field is unreliable here (garbage
// "6692523621", typo "Zachodnipomorskie", and flatly wrong "Świeradów Zdrój =
// zachodniopomorskie"). Since the merge never overwrites an existing voivodeship,
// emitting a wrong one would permanently pollute. We pass only the clean city as
// `location` and let the pipeline's geocode step derive voivodeship from it.

const API = 'https://herkules.org.pl/wp-json/tribe/events/v1/events'
const UA = 'leszy.run/1.0 (kontakt@leszy.run)'

// Categories that mean "this is (also) a running/NW event we want". An event is
// dropped only when ALL its categories fall outside this set (pure SUP / cycling /
// MTB / triathlon).
const RUNNING_CATS = new Set(['bieganie', 'nordic-walking', 'bieganie-z-przeszkodami'])

function detectEventTypes(name) {
  const blob = (name || '').toLowerCase()
  const tags = new Set()
  // przełaj(owy) = cross-country, górski/leśny = mountain/forest → trail
  if (/g[oó]rsk[aiey]|le[sś]n[aey]|\btrail\b|cross(?:owy|owa|owe)?\b|prze[lł]aj/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b/i.test(blob)) tags.add('ocr')
  return [...tags]
}

// Style tags derived from the event's own Tribe categories (umbrella-level).
function categoryStyleTags(catSlugs) {
  const tags = new Set()
  if (catSlugs.includes('nordic-walking')) tags.add('nordic walking')
  if (catSlugs.includes('bieganie-z-przeszkodami')) tags.add('ocr')
  return [...tags]
}

// \b doesn't recognize Polish letters in JS — use manual non-letter boundary.
const NB = '[^a-ząćęłńóśźż]'
function hasKidsSignal(name) {
  if (!name) return false
  const s = ` ${name.toLowerCase()} `
  if (/(?:biegi|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}świetlik`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

// Tribe titles come HTML-entity-encoded ("&#8211;" en-dash, "&#8243;" ″, "&#8220;").
function decodeEntities(str) {
  if (!str) return str
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Facility/address keywords that mean the `venue` field holds a place name, not
// a bare town. Used only as a fallback when `venue.city` is empty.
const VENUE_NOISE = /\d|,|ul\.|al\.|os\.|pl\.|stadion|hala|orlik|ośrodek|centrum|\bch\b|hotel|park|polana|\bpole\b|latarnia|siedlisko|zamek|sanktuarium|osir|gminne|szkoln/i

// `venue.city` is the reliable source. When it's empty, the venue *name* field
// occasionally holds a bare town ("Police") — but usually a facility/address
// ("CH EMKA KOSZALIN", "Stadion Miejski w Człopie"). Accept it as a city only
// when it looks like a bare town: no digits/comma/keyword, ≤ 2 words. Otherwise
// return null and let the geocode step flag the missing location.
function cityFromVenueName(venueName) {
  const v = (venueName || '').trim()
  if (!v || VENUE_NOISE.test(v)) return null
  if (v.split(/\s+/).length > 2) return null
  return v
}

export async function scrape({ knownIds } = {}) {
  const known = knownIds || new Set()
  const today = new Date().toISOString().slice(0, 10)

  const results = []
  let page = 1
  let totalPages = 1

  do {
    const url = `${API}?per_page=50&page=${page}&start_date=${today}`
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) {
      console.error(`[herkules] page ${page} HTTP ${res.status}`)
      break
    }
    const data = await res.json()
    totalPages = data.total_pages || 1

    for (const e of data.events || []) {
      const name = decodeEntities(e.title)
      const date = (e.start_date || '').slice(0, 10)
      if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue

      const catSlugs = (e.categories || []).map((c) => c.slug)
      // Drop pure non-running events (SUP / cycling / MTB / triathlon).
      if (catSlugs.length && !catSlugs.some((c) => RUNNING_CATS.has(c))) continue

      const sourceId = String(e.id)
      if (known.has(sourceId)) continue

      const venue = e.venue || {}
      const city = (venue.city || '').trim() || cityFromVenueName(venue.venue) || null

      // event_types: the Tribe category is the timing co's own umbrella-level
      // classification and is authoritative for style (nw/ocr) — terrain words in
      // the name ("górski", "przełajowy") must NOT override it, or a Nordic Walking
      // mountain championship gets mis-tagged trail. So:
      //   - if the event has a style category (nw/ocr) → use it; add name-derived
      //     'ultra' (orthogonal to nw/trail/ocr) if present.
      //   - if it has no style category (plain "bieganie") → trust the name
      //     (trail / ultra / etc.).
      // This also keeps the tag set umbrella-clean: we never stack a name style on
      // top of a category style, so merges with umbrella-only aggregators hold.
      const catTags = categoryStyleTags(catSlugs)
      let eventTypes
      if (catTags.length > 0) {
        const set = new Set(catTags)
        if (detectEventTypes(name).includes('ultra')) set.add('ultra')
        eventTypes = [...set]
      } else {
        eventTypes = detectEventTypes(name)
      }

      const website = (e.website || '').trim() || null

      results.push({
        name,
        date,
        location: city,
        distances: null, // enricher fills from registration page
        registration_url: website,
        regulamin_url: null,
        website: null,
        is_kids: hasKidsSignal(name),
        event_types: eventTypes,
        source: 'herkules',
        source_id: sourceId,
        source_url: e.url || null,
      })
    }

    page += 1
  } while (page <= totalPages)

  return results
}
