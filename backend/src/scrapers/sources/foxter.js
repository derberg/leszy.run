import * as cheerio from 'cheerio'

// foxter-sport.pl — custom PHP timing company (Wielkopolska / Kujawsko-Pomorskie
// heavy) that hosts its own event registration. The /list page is a single
// server-rendered DataTables table; every row exposes date (YYYY-MM-DD in
// p.compDate), name + slug (/<slug> detail link), a Google-Maps place link, the
// organizer, and a "Zapisz się" button (/registration/register/<regId>).
//
// The /<slug> detail page IS the canonical public registration landing (the
// register button itself redirects to /login). It carries the structured
// distances as a.distance-button tab labels and a regulamin PDF at
// /uploads/competition/comp_regulations_<regId>.pdf.
//
// Prices live behind the login wall (/registration/register/<id> → /login), so
// the scraper leaves price_from/price_to/registration_deadline to the enricher.
//
// Priority 3: a timing co hosting canonical registration for its own events —
// beats aggregators on field conflicts (see dedup.js SOURCE_PRIORITY).
const BASE_URL = 'https://foxter-sport.pl'
const LIST_URL = `${BASE_URL}/list`
const USER_AGENT = 'leszy.run/1.0 (kontakt@leszy.run)'

// Non-running events foxter also hosts (triathlon, open water, cycling, …).
// The merge step filters these too, but skipping here keeps scraper_foxter
// clean. OCR / obstacle races involve running, so they're kept.
const NON_RUNNING_RE =
  /triathlon|duathlon|aquathlon|swimrun|open\s*water|\bp[lł]ywack|rajd\s+rowerow|rowerow|\bmtb\b|kolarsk|\brolki\b|pit\s*bike|moto\s*cup|motocross|\bmoto\b/i

// Manual non-letter boundary — JS \b doesn't recognize Polish letters.
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

// event_type tags from the umbrella event name only. Foxter's distance buttons
// are distances (not style names), so there's no safe sub-race style to mine —
// mining would only risk a double-style tag-set mismatch with umbrella-only
// aggregators (see skill 5b). "przeszkodow" maps to OCR.
function detectEventTypes(name) {
  const blob = (name || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|leśn[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|ultramaraton|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b|przeszkodow/i.test(blob)) tags.add('ocr')
  return [...tags]
}

// A distance-button label is free-form per event:
//   "około 48 km"               → "48 km"
//   "150 m (Rocznik 2022 - 2023)" → "150 m"
//   "1. niedamiRUN_zaDycha 10K"  → "10 km"   (uppercase K = km)
//   "4. niedamiRUN_ultra 100K"   → "100 km"
// Strip the ordinal prefix, "około", and any "(Rocznik …)" annotation, then take
// the first distance token, preferring km/K over m. Returns null when no token.
function cleanDistance(label) {
  if (!label) return null
  let s = label
    .replace(/^\s*\d+\.\s*/, '') // "1. " ordinal
    .replace(/około/gi, '')
    .replace(/\([^)]*\)/g, '') // "(Rocznik …)"
  let m = s.match(/(\d+(?:[.,]\d+)?)\s*(?:km|k)\b/i)
  if (m) return `${m[1].replace(',', '.')} km`
  m = s.match(/(\d+(?:[.,]\d+)?)\s*m\b/i)
  if (m) return `${m[1].replace(',', '.')} m`
  return null
}

// Distance in km for the kids heuristic (≤ 1 km → kids race).
function distanceKm(clean) {
  if (!clean) return null
  const m = clean.match(/^(\d+(?:\.\d+)?)\s*(km|m)$/)
  if (!m) return null
  const n = parseFloat(m[1])
  return m[2] === 'm' ? n / 1000 : n
}

async function fetchListing() {
  const res = await fetch(LIST_URL, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`listing ${res.status} ${res.statusText}`)
  return res.text()
}

// Parse /list into [{ slug, name, date, location }]. Rows without a date, a
// name, or a /<slug> detail link are skipped per skill rules.
function parseListing(html) {
  const $ = cheerio.load(html)
  const events = []
  $('tbody tr').each((_, tr) => {
    const r = $(tr)
    const date = r.find('p.compDate').first().text().trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return
    const nameA = r.find('td:nth-child(2) a').first()
    const name = nameA.text().replace(/\s+/g, ' ').trim()
    const slug = (nameA.attr('href') || '').replace(/^\//, '').trim()
    if (!name || !slug) return
    // Visible place text inside the map-link anchor (strip the marker icon).
    const placeA = r.find('td:nth-child(4) a').first()
    const location = placeA.clone().children().remove().end().text().replace(/\s+/g, ' ').trim() || null
    events.push({ slug, name, date, location })
  })
  return events
}

// Fetch a /<slug> detail page → distances + regulamin PDF + kids flag.
async function fetchDetail(slug) {
  const empty = { distances: null, regulaminUrl: null, website: null, isKids: false }
  try {
    const res = await fetch(`${BASE_URL}/${slug}`, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) return empty
    const html = await res.text()
    const $ = cheerio.load(html)

    const distances = new Set()
    let kidsByDistance = false
    let kidsByRocznik = false
    $('a.distance-button').each((_, a) => {
      const label = $(a).text().replace(/\s+/g, ' ').trim()
      if (/rocznik/i.test(label)) kidsByRocznik = true
      const d = cleanDistance(label)
      if (!d) return
      distances.add(d)
      const km = distanceKm(d)
      if (km != null && km <= 1) kidsByDistance = true
    })

    let regulaminUrl = null
    $('a[href*="comp_regulations"], a[href$=".pdf"]').each((_, a) => {
      if (regulaminUrl) return
      const href = $(a).attr('href') || ''
      if (/\.pdf$/i.test(href)) regulaminUrl = href.startsWith('http') ? href : BASE_URL + href
    })

    // Organizer website — the detail page has a dedicated "Strona zawodów"
    // (event website) link in the links list. That's the source's DECLARED
    // official link, so trust it as-is even when it's a Facebook page (a valid
    // official presence for many events; skill 5f). Selecting by the label
    // avoids the page's facebook.com/sharer.php share widget entirely; we only
    // additionally reject foxter's own host.
    let website = null
    $('a[target="_blank"]').each((_, a) => {
      if (website) return
      const txt = $(a).text().replace(/\s+/g, ' ').trim()
      if (!/strona zawod[oó]w/i.test(txt)) return
      const href = $(a).attr('href') || ''
      if (/^https?:\/\//i.test(href) && !/foxter-sport\.pl|sharer\.php/i.test(href)) website = href
    })

    return {
      distances: distances.size ? [...distances].join(', ') : null,
      regulaminUrl,
      website,
      isKids: kidsByDistance || kidsByRocznik,
    }
  } catch (err) {
    console.error(`[foxter] Detail fetch failed for ${slug}:`, err.message)
    return empty
  }
}

async function scrape({ knownIds = new Set() } = {}) {
  let html
  try {
    html = await fetchListing()
  } catch (err) {
    console.error(`[foxter] Listing fetch failed:`, err.message)
    return []
  }

  const listing = parseListing(html)
  console.log(`[foxter] Listing: ${listing.length} events parsed`)

  const running = listing.filter((e) => !NON_RUNNING_RE.test(e.name))
  console.log(`[foxter] ${listing.length - running.length} non-running skipped`)

  // Emit only new events (timekeeper/zapisyonline pattern): detail is fetched
  // only for new rows, so re-emitting known rows would null their distances.
  const newEntries = running.filter((e) => !knownIds.has(e.slug))
  console.log(`[foxter] ${newEntries.length} new (skipping ${running.length - newEntries.length} known)`)

  const results = []
  for (const entry of newEntries) {
    const detail = await fetchDetail(entry.slug)
    await new Promise((r) => setTimeout(r, 1100))
    console.log(`[foxter] Detail ${results.length + 1}/${newEntries.length} — ${entry.name}`)

    const sourceUrl = `${BASE_URL}/${entry.slug}`
    const eventTypes = detectEventTypes(entry.name)
    results.push({
      name: entry.name,
      date: entry.date,
      location: entry.location,
      distances: detail.distances,
      registration_url: sourceUrl,
      registration_deadline: null,
      regulamin_url: detail.regulaminUrl,
      website: detail.website,
      is_kids: detail.isKids || hasKidsSignal(entry.name),
      event_types: eventTypes.length ? eventTypes : null,
      price_from: null,
      price_to: null,
      source: 'foxter',
      source_id: entry.slug,
      source_url: sourceUrl,
    })
  }

  console.log(`[foxter] Scraped ${results.length} events`)
  return results
}

export { scrape, parseListing, cleanDistance, detectEventTypes, hasKidsSignal, fetchDetail }
