import * as cheerio from 'cheerio'

const BASE_URL = 'https://rajsportactive.pl'
const LISTING_URL = `${BASE_URL}/zapisy`
const USER_AGENT = 'leszy.run/1.0 (kontakt@leszy.run)'

// "09.05.2026 (SOBOTA) - Wróblew" → ['2026-05-09', 'Wróblew']
// Weekday in parens is optional; multi-word locations like "Kamień, Gmina Ceków-Kolonia" preserved.
function parseListingDateLocation(raw) {
  if (!raw) return { date: null, location: null }
  const m = raw.match(/^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*(?:\([^)]*\))?\s*[-–]\s*(.+?)\s*$/)
  if (!m) {
    const dOnly = raw.match(/^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/)
    if (!dOnly) return { date: null, location: null }
    return { date: `${dOnly[3]}-${dOnly[2].padStart(2, '0')}-${dOnly[1].padStart(2, '0')}`, location: null }
  }
  const date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return { date, location: m[4].trim() || null }
}

function cleanName(raw) {
  if (!raw) return ''
  // Strip operator notes like " - UWAGA! ZAPISUJĄC SIĘ OD 4.05.2026 NIE GWARANTUJEMY KOSZULKI W PAKIECIE"
  return raw.replace(/\s*[-–]\s*UWAGA[!:]?.*$/i, '').replace(/\s+/g, ' ').trim()
}

// Extract registration URL slug from a hash-anchored "Lista startowa" URL.
// "https://rajsportactive.pl/zapisy/wroblewska-eko-dycha-2026#lista" → "wroblewska-eko-dycha-2026"
function extractSlug(href) {
  if (!href) return null
  const m = href.match(/\/zapisy\/([a-z0-9][a-z0-9-]+)/i)
  return m ? m[1] : null
}

// Numeric distance ("5km", "10K", "21,1 km") + Polish race aliases. Skips
// swimming sub-events ("Maraton Pływacki") to avoid emitting "Maraton" as a
// running distance.
function distancesFromButton(label) {
  if (!label) return []
  if (/p[lł]ywack/i.test(label)) return []
  const out = new Set()
  const numRe = /(\d+(?:[.,]\d+)?)\s*km?\b/gi
  for (const m of label.matchAll(numRe)) {
    const num = m[1].replace(',', '.')
    out.add(`${num} km`)
  }
  if (out.size === 0) {
    if (/\bp[oó][lł]\s*maraton/i.test(label)) out.add('Półmaraton')
    else if (/\bmaraton\b/i.test(label)) out.add('Maraton')
    if (/\bdycha\b/i.test(label)) out.add('10 km')
    if (/\bpi[aą]tka\b/i.test(label)) out.add('5 km')
  }
  return [...out]
}

// Kids signal — `\b` doesn't recognize Polish letters in JS regex, so lowercase
// + non-letter-boundary. Mirrors bgtimesport.hasKidsSignal.
function hasKidsSignal(text) {
  if (!text) return false
  const s = ` ${text.toLowerCase()} `
  const NB = '[^a-ząćęłńóśźż]'
  if (new RegExp(`(?:biegi|bieg|dla)\\s+dzieci`).test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}świetlik`).test(s)) return true
  if (new RegExp(`${NB}rodzink[ai]${NB}`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

// Heuristic event_type tagging from the umbrella name only — keeps tag set
// aligned with biegiwpolsce/maratonypolskie so the distinguishing-tag merge
// guard passes. Subdivision buttons deliberately ignored.
function detectEventTypes(name) {
  const blob = (name || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|leśn[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b/i.test(blob)) tags.add('ocr')
  return [...tags]
}

async function fetchListing() {
  const res = await fetch(LISTING_URL, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`listing ${res.status} ${res.statusText}`)
  return res.text()
}

function parseListing(html) {
  const $ = cheerio.load(html)
  const events = []

  $('.opaska').each((_, el) => {
    const card = $(el)
    const rawName = card.find('.zawody-nazwa h4').first().text()
    const name = cleanName(rawName)
    if (!name) return

    const dateLocText = card.find('.zawody-nazwa p').first().text().trim()
    const { date, location } = parseListingDateLocation(dateLocText)
    if (!date) return // drop undated rows per skill rules

    // Registration URL: first .button-reg in .zapisy-pliki points to the
    // event's "Lista startowa" page (rajsportactive.pl/zapisy/<slug>#lista).
    // Strip the #lista anchor — the bare /zapisy/<slug> is the registration
    // page where users actually sign up.
    let regHref = null
    let regulaminHref = null
    card.find('.zapisy-pliki .button-reg').each((_, a) => {
      const href = $(a).attr('href') || ''
      if (!href) return
      if (/\.pdf(\?|$)/i.test(href)) {
        if (!regulaminHref) regulaminHref = href
      } else if (/\/zapisy\//i.test(href)) {
        if (!regHref) regHref = href.split('#')[0]
      }
    })

    if (!regHref) return

    const slug = extractSlug(regHref)
    if (!slug) return

    // Distances + kids signal harvested from registration buttons
    const distances = new Set()
    let hasKidsButton = false
    card.find('.zapisy-buttony .button').each((_, a) => {
      const label = $(a).text().trim()
      if (!label) return
      if (hasKidsSignal(label)) hasKidsButton = true
      for (const d of distancesFromButton(label)) distances.add(d)
    })

    events.push({
      name,
      date,
      location,
      distances: distances.size > 0 ? [...distances].join(', ') : null,
      registration_url: regHref,
      regulamin_url: regulaminHref,
      is_kids: hasKidsSignal(name) || hasKidsButton,
      event_types: detectEventTypes(name),
      source_id: slug,
      source_url: regHref,
    })
  })

  return events
}

async function scrape({ knownIds = new Set() } = {}) {
  let html
  try {
    html = await fetchListing()
  } catch (err) {
    console.error('[rajsportactive] Listing fetch failed:', err.message)
    return []
  }

  const events = parseListing(html)
  console.log(`[rajsportactive] Listing: ${events.length} events parsed`)

  // Listing-only scraper — no detail fetch. Safe to emit all events on every
  // run; the pipeline's UPDATE path refreshes distances/regulamin/etc. without
  // resetting merged_at, so already-merged scraper_all rows stay merged.
  const newCount = events.filter(e => !knownIds.has(e.source_id)).length
  console.log(`[rajsportactive] ${newCount} new, ${events.length - newCount} known`)

  const results = events.map(e => ({
    ...e,
    event_types: e.event_types.length > 0 ? e.event_types : null,
    source: 'rajsportactive',
  }))

  console.log(`[rajsportactive] Scraped ${results.length} events`)
  return results
}

export {
  scrape,
  parseListing,
  parseListingDateLocation,
  cleanName,
  distancesFromButton,
  hasKidsSignal,
  detectEventTypes,
}
