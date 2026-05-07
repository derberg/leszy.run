import * as cheerio from 'cheerio'

const BASE_URL = 'https://www.bgtimesport.pl'
const LISTING_URL = `${BASE_URL}/zawody`
const USER_AGENT = 'leszy.run/1.0 (kontakt@leszy.run)'

// Listing dates are like "10.05.2026", "6.06.2026", "13-14.06.2026", "04.01.2026 zmiana terminu".
// For multi-day events use the first day. Strip any trailing notice text.
function parseListingDate(raw) {
  if (!raw) return null
  const m = raw.match(/^\s*(\d{1,2})(?:-\d{1,2})?\.(\d{1,2})\.(\d{4})\b/)
  if (!m) return null
  const dd = m[1].padStart(2, '0')
  const mm = m[2].padStart(2, '0')
  const yyyy = m[3]
  return `${yyyy}-${mm}-${dd}`
}

// Bieg subnames imply distance — extract obvious patterns. Returns array of strings
// like "5 km", "10 km", "Półmaraton", "Maraton". Falls back to empty list.
function distancesFromBiegName(name) {
  if (!name) return []
  const out = new Set()
  // Numeric "5 km" / "5km" / "21,1 km" / "21.0975km"
  const numRe = /(\d+(?:[.,]\d+)?)\s*km\b/gi
  for (const m of name.matchAll(numRe)) {
    const num = m[1].replace(',', '.')
    out.add(`${num} km`)
  }
  // Polish nicknames — only emit when the numeric form wasn't already captured
  if (out.size === 0) {
    if (/\bp[oó]ł\s*maraton/i.test(name)) out.add('Półmaraton')
    else if (/\bmaraton\b/i.test(name)) out.add('Maraton')
    if (/\bdycha\b/i.test(name)) out.add('10 km')
    if (/\bpi[aą]tka\b/i.test(name)) out.add('5 km')
    if (/\bsetka\b/i.test(name)) out.add('100 km')
  }
  return [...out]
}

// Detects a kids/youth signal in any name fragment — used both for the umbrella
// event name AND for individual bieg subdivisions on the detail page. Following
// the lumisport convention: an umbrella event with ANY kids variant is flagged
// is_kids=true so the merge guard's audience:kids tag matches enriched rows
// from other scrapers that already have 'dzieci' in event_types.
//
// \b doesn't recognize Polish letters in JS regex, so we lowercase and use a
// manual non-letter boundary.
function hasKidsSignal(name) {
  if (!name) return false
  const s = ` ${name.toLowerCase()} `
  const NB = '[^a-ząćęłńóśźż]'
  if (new RegExp(`(?:biegi|dla)\\s+dzieci`).test(s)) return true
  if (new RegExp(`dzieci\\s+i\\s+m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}świetlik`).test(s)) return true
  if (new RegExp(`${NB}przedszkol`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  // "Mini..." as a word — both at start of umbrella name (e.g. "MiniKierpce")
  // AND mid-name as a subdivision (e.g. "& miniBucze"). The non-letter prefix
  // prevents matching unrelated words like "administrative". Allow hyphen
  // after "mini" for compounds like "Mini-Maraton".
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

// Backwards-compatible alias used in existing tests.
const isKidsEvent = hasKidsSignal

// Heuristic event_type tagging from the umbrella name only. Mirrors the
// categories distinguishingTags() recognizes (trail, nordic walking, ultra,
// ocr) so fuzzy matches against LLM-enriched scraper_all rows pass the guard.
// "Górski" / "górska" / "leśne" → trail because BGTimeSport's catalogue
// is overwhelmingly mountain/forest runs in Beskidy and Tatry. Subdivision
// headings are deliberately ignored to align with other scrapers — picking
// up an NW subdivision on a primarily-running event would create a tag-set
// mismatch with the same row from biegiwpolsce/maratonypolskie.
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

  $('.grid-container .thumbnail').each((_, el) => {
    const card = $(el)
    const onclick = card.attr('onclick') || ''
    const idMatch = onclick.match(/\/zawody\/zaw\/id\/(\d+)/)
    if (!idMatch) return
    const sourceId = idMatch[1]

    const dateRaw = card.find('.data').first().text().trim()
    const location = card.find('.miejsce').first().text().trim() || null
    const name = card.find('h4.nazwa b').first().text().trim()
      || card.find('h4.nazwa').first().text().trim()
    if (!name) return

    const date = parseListingDate(dateRaw)
    if (!date) return // drop undated rows per skill rules

    events.push({ sourceId, name, date, location })
  })

  return events
}

async function fetchDetail(sourceId) {
  // /zawody/zaw/id/<N> 302s to /zawody/biegi/id/<N> — go straight to /biegi.
  const url = `${BASE_URL}/zawody/biegi/id/${sourceId}`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) return { distances: [], priceFrom: null, priceTo: null, website: null }
    const html = await res.text()
    const $ = cheerio.load(html)

    // Each "bieg" panel: .panel.panel-default.col-xs-12 with an <h4>name</h4> and price <h6>X zł</h6>.
    // The first such panel is the umbrella "INFORMACJE O ZAWODACH" — skip it.
    const distances = new Set()
    const prices = []
    const biegHeadings = []
    let hasKidsBieg = false
    $('.panel.panel-default').each((_, panel) => {
      const $panel = $(panel)
      const heading = $panel.find('h4').first().text().trim()
      if (!heading || /informacje o zawodach/i.test(heading)) return

      biegHeadings.push(heading)
      for (const d of distancesFromBiegName(heading)) distances.add(d)
      if (hasKidsSignal(heading)) hasKidsBieg = true

      $panel.find('h6 b').each((_, b) => {
        const text = $(b).text().trim()
        const m = text.match(/(\d+(?:[.,]\d+)?)\s*zł/i)
        if (m) {
          const n = parseFloat(m[1].replace(',', '.'))
          if (Number.isFinite(n) && n >= 0) prices.push(n)
        }
      })
    })

    // External organizer website — side panel "Strona internetowa:" link
    let website = null
    $('a[target="_blank"][href^="http"]').each((_, a) => {
      if (website) return
      const href = $(a).attr('href') || ''
      // Skip BGTimeSport's own subdomains
      if (/bgtimesport\.pl/i.test(href)) return
      website = href
    })

    return {
      distances: [...distances],
      priceFrom: prices.length ? Math.min(...prices) : null,
      priceTo: prices.length ? Math.max(...prices) : null,
      website,
      hasKidsBieg,
      biegHeadings,
    }
  } catch (err) {
    console.error(`[bgtimesport] Detail fetch failed for ${sourceId}:`, err.message)
    return { distances: [], priceFrom: null, priceTo: null, website: null, hasKidsBieg: false, biegHeadings: [] }
  }
}

async function fetchRegulaminPdf(sourceId) {
  const url = `${BASE_URL}/zawody/regulamin/id/${sourceId}`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) return null
    const html = await res.text()
    const $ = cheerio.load(html)
    let pdf = null
    $('a[href$=".pdf"], a[href*=".pdf?"]').each((_, el) => {
      if (pdf) return
      const href = $(el).attr('href') || ''
      if (!href) return
      pdf = href.startsWith('http') ? href : new URL(href, BASE_URL).toString()
    })
    return pdf
  } catch {
    return null
  }
}

async function scrape({ knownIds = new Set() } = {}) {
  let listingHtml
  try {
    listingHtml = await fetchListing()
  } catch (err) {
    console.error('[bgtimesport] Listing fetch failed:', err.message)
    return []
  }

  const listing = parseListing(listingHtml)
  console.log(`[bgtimesport] Listing: ${listing.length} events parsed`)

  const newEntries = listing.filter(e => !knownIds.has(e.sourceId))
  console.log(`[bgtimesport] ${newEntries.length} new (skipping ${listing.length - newEntries.length} known)`)

  // Only emit new events — same pattern as timekeeper. Known rows would
  // otherwise have null distances/prices/website (we don't re-fetch detail
  // for them), and the pipeline's UPDATE path would clear those fields.
  const results = []
  for (const entry of newEntries) {
    const sourceUrl = `${BASE_URL}/zawody/biegi/id/${entry.sourceId}`
    const detail = await fetchDetail(entry.sourceId)
    await new Promise(r => setTimeout(r, 1100))
    const regulaminUrl = await fetchRegulaminPdf(entry.sourceId)
    await new Promise(r => setTimeout(r, 1100))
    console.log(`[bgtimesport] Detail ${results.length + 1}/${newEntries.length} — ${entry.name}`)

    const eventTypes = detectEventTypes(entry.name)
    results.push({
      name: entry.name,
      date: entry.date,
      location: entry.location,
      distances: detail.distances.length ? detail.distances.join(', ') : null,
      registration_url: sourceUrl,
      regulamin_url: regulaminUrl,
      website: detail.website,
      is_kids: hasKidsSignal(entry.name) || detail.hasKidsBieg,
      price_from: detail.priceFrom,
      price_to: detail.priceTo,
      event_types: eventTypes.length ? eventTypes : null,
      source: 'bgtimesport',
      source_id: entry.sourceId,
      source_url: sourceUrl,
    })
  }

  console.log(`[bgtimesport] Scraped ${results.length} events`)
  return results
}

export { scrape, parseListingDate, distancesFromBiegName, isKidsEvent, hasKidsSignal, detectEventTypes, parseListing }
