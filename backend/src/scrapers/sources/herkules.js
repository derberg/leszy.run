import * as cheerio from 'cheerio'

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
// Website, registration and regulamin: the `website` field ("Witryna internetowa")
// is the race's own site, NOT a registration form. It is a b4sportonline mini-site
// (b4sportonline.pl/<slug>/), a b4sport white-label domain (biegikoszalin.eu,
// biegislupsk.pl) or inws.info. Until 2026-11-20 it was published as
// registration_url, so XVIII KOSZALIŃSKI BIEG GÓRSKI offered https://biegikoszalin.eu/
// as its sign-up link. Now it is `website`, and the site itself is read for the
// two links its own UI exposes (siteLinks):
//   - registration_url: the "Zapisy" card whose href carries the race date,
//     `zapisy_na_<DDMMYYYY>__<slug>`. With several cards on that date the one
//     whose slug shares the most words with the name wins; a tie gives nothing.
//     A site whose cards carry no date offers the card sharing two or more words
//     with the name.
//     VERIFIED 2026-11-20: biegikoszalin.eu/Biegi_Koszalin_2016/
//     zapisy_na_10042027__xviii_koszalinski_bieg_gorski answers 200 with
//     "Zapisy na 10.04.2027 - XVIII KOSZALIŃSKI BIEG GÓRSKI" and the form;
//     b4sportonline.pl/biegi_kolobrzeg/zapisy_na_20032027__kolobrzeska_15stka_zaslubin
//     is the same page type for Kołobrzeska 15-stka.
//   - regulamin_url: a menu entry "Regulamin - <race>" naming the race, else the
//     one plain "Regulamin" button when the site has exactly one target. These are
//     HTML regulamin pages (biegikoszalin.eu/Biegi_Koszalin_2016/regbg2027 holds
//     the 2027 rules: 5 km, 60/70/100 zł).
// A platform root (b4sportonline.pl/, inws.info/) names no race and is dropped.
// Herkules lists ~10 future events, so every one is read on every run: a known
// id is not skipped, or a race whose sign-up opens later would never get it.
//
// Distances / prices: NOT in the API (cost is empty). Left to the enricher, which
// reads them from the regulamin found here.
//
// Voivodeship: NOT emitted. The venue region field is unreliable here (garbage
// "6692523621", typo "Zachodnipomorskie", and flatly wrong "Świeradów Zdrój =
// zachodniopomorskie"). Since the merge never overwrites an existing voivodeship,
// emitting a wrong one would permanently pollute. We pass only the clean city as
// `location` and let the pipeline's geocode step derive voivodeship from it.

const API = 'https://herkules.org.pl/wp-json/tribe/events/v1/events'
const UA = 'leszy.run/1.0 (lukasz@leszy.run)'

const PLATFORM_HOSTS = new Set(['b4sportonline.pl', 'www.b4sportonline.pl', 'inws.info', 'www.inws.info'])

// A registration platform's home page: it names no race, so it is neither the
// race's website nor its sign-up page.
export function isPlatformRoot(url) {
  try {
    const u = new URL(url)
    return PLATFORM_HOSTS.has(u.hostname) && (u.pathname === '/' || u.pathname === '')
  } catch {
    return false
  }
}

// Words that say nothing about which race it is.
const STOPWORDS = new Set(['bieg', 'biegu', 'biegi', 'w', 'i', 'na', 'z', 'ze', 'do', 'o', 'po', 'im', 'the'])

function words(text) {
  return new Set(
    (text || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/ł/g, 'l')
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !STOPWORDS.has(w)),
  )
}

function shared(a, b) {
  let n = 0
  for (const w of a) if (b.has(w)) n++
  return n
}

function absolute(href, baseUrl) {
  try { return new URL(href, baseUrl).href } catch { return null }
}

// The sign-up card and the regulamin of one race, read from its b4sport site.
export function siteLinks(html, baseUrl, { name, date }) {
  const $ = cheerio.load(html)
  const nameWords = words(name)
  const [y, m, d] = date.split('-')
  const stamp = `zapisy_na_${d}${m}${y}__`

  const cards = new Map()
  const undated = new Map()
  const titled = new Map()
  const plain = new Set()
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    const url = absolute(href, baseUrl)
    if (!url) return
    const path = new URL(url).pathname
    const i = path.indexOf(stamp)
    if (i >= 0) {
      // b4sportonline.pl and the white-label host serve the same card; key by path.
      const key = path.replace(/\/\d+$/, '')
      if (!cards.has(key)) cards.set(key, { url: absolute(key, baseUrl), score: shared(nameWords, words(path.slice(i + stamp.length))) })
      return
    }
    const bare = path.match(/\/zapisy_na_(?!\d{8}__)([^/]+)/)
    if (bare) {
      const key = path.replace(/\/\d+$/, '')
      if (!undated.has(key)) undated.set(key, { url: absolute(key, baseUrl), score: shared(nameWords, words(bare[1])) })
      return
    }
    if (/\/zapisy_na_/.test(path)) return
    const text = $(el).text().replace(/\s+/g, ' ').trim()
    const titledMatch = text.match(/^Regulamin\s*[-–]\s*(.+)$/i)
    if (titledMatch) {
      const t = words(titledMatch[1])
      const overlap = shared(nameWords, t) / Math.max(1, Math.min(nameWords.size, t.size))
      if (!titled.has(path)) titled.set(path, { url: absolute(path, baseUrl), overlap })
    } else if (/^Regulamin$/i.test(text)) {
      plain.add(new URL(url).pathname)
    }
  })

  return {
    // A card with no date in its slug (b4sportonline.pl/polmaraton_kolobrzeg/
    // zapisy_na_iv_kolobrzeski_polmaratron_brzegiem_baltyku) counts only when no
    // card carries the race date, and must share two words with the name.
    registrationUrl: cards.size
      ? uniqueBest([...cards.values()], 'score', 1)
      : uniqueBest([...undated.values()], 'score', 2),
    regulaminUrl: uniqueBest([...titled.values()], 'overlap', 0.6)
      ?? (titled.size === 0 && plain.size === 1 ? absolute([...plain][0], baseUrl) : null),
  }
}

// The candidate scoring strictly highest and at least `min`; a tie names nothing.
function uniqueBest(candidates, key, min) {
  const sorted = candidates.filter((c) => c[key] >= min).sort((a, b) => b[key] - a[key])
  if (sorted.length === 0) return null
  if (sorted.length > 1 && sorted[1][key] === sorted[0][key]) return null
  return sorted[0].url
}

async function readSite(url, race) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) return { registrationUrl: null, regulaminUrl: null }
    return siteLinks(await res.text(), res.url || url, race)
  } catch (err) {
    console.error(`[herkules] ${url}: ${err.message}`)
    return { registrationUrl: null, regulaminUrl: null }
  }
}

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

export async function scrape() {
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

      const declared = (e.website || '').trim() || null
      const website = declared && !isPlatformRoot(declared) ? declared : null
      const links = website ? await readSite(website, { name, date }) : { registrationUrl: null, regulaminUrl: null }

      results.push({
        name,
        date,
        location: city,
        distances: null, // enricher fills from the regulamin
        registration_url: links.registrationUrl,
        regulamin_url: links.regulaminUrl,
        website,
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
