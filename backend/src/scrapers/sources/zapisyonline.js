import * as cheerio from 'cheerio'

// zapisyonline.pl — custom PHP registration platform (by Triso.pl) where
// organizers host their own event registration. Events register DIRECTLY on
// zapisyonline.pl, so the /wydarzenie/<id>,<slug> detail page IS the canonical
// registration landing page (the user picks a distance there). Comparable genre
// to elektronicznezapisy / inessport — a registration host, not a listing
// aggregator.
//
// Listing: /zapisy?p=0 and /zapisy?p=1 (server-rendered, ~20 events/page,
// future-only, sorted by date). Each .event row exposes date, city, name and a
// /wydarzenie/<id>,<slug> link. Detail page carries a .competitions sub-table
// (distance + "Zawody dla dzieci/dorosłych"), an organizer website link, and a
// /files/_rules/<id>/<file>.pdf regulamin.
const BASE_URL = 'https://zapisyonline.pl'
const LIST_URL = `${BASE_URL}/zapisy`
const USER_AGENT = 'leszy.run/1.0 (kontakt@leszy.run)'
const MAX_PAGES = 6 // safety cap; real data is currently 2 pages

// Cycling / non-running events the platform also hosts. The merge step filters
// these too, but skipping here keeps scraper_zapisyonline clean. Orienteering
// ("gra na orientację") involves running, so it's kept.
const NON_RUNNING_RE = /rajd\s+rowerow|rowerow|\bmtb\b|kolarsk|spinning|triathlon|duathlon|p[lł]ywack/i

// Listing date is "DD.MM.YYYY". Far-future placeholder dates (e.g. 01.01.2030)
// are "date TBD" markers the organizer hasn't finalized — they parse fine and
// the downstream future-event filter keeps them.
function parseListingDate(raw) {
  if (!raw) return null
  const m = raw.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/)
  if (!m) return null
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

// distances arrive clean from the .item.distance column ("5 km", "300 m"),
// just normalize spacing and dedupe.
function cleanDistance(raw) {
  if (!raw) return null
  const m = raw.trim().match(/^(\d+(?:[.,]\d+)?)\s*(km|m)\b/i)
  if (!m) return null
  return `${m[1].replace(',', '.')} ${m[2].toLowerCase()}`
}

// event_type tags from the umbrella name only (mirrors distinguishingTags()).
function detectEventTypes(name) {
  const blob = (name || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|leśn[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b/i.test(blob)) tags.add('ocr')
  return [...tags]
}

async function fetchPage(p) {
  const res = await fetch(`${LIST_URL}?p=${p}`, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`listing p=${p} ${res.status} ${res.statusText}`)
  return res.text()
}

// Parse one listing page into [{ sourceId, name, date, location }]. Header rows
// (.event.headers) and rows without a /wydarzenie/ link are skipped.
function parseListing(html) {
  const $ = cheerio.load(html)
  const events = []
  $('.event').each((_, el) => {
    const row = $(el)
    if (row.hasClass('headers')) return
    const href = row.find('.item.name a').attr('href') || ''
    const idMatch = href.match(/\/wydarzenie\/(\d+),([^"']+)/)
    if (!idMatch) return
    const sourceId = idMatch[1]
    const name = row.find('.item.name a').first().text().replace(/\s+/g, ' ').trim()
    const date = parseListingDate(row.find('.item.date').first().text())
    const location = row.find('.item.place').first().text().replace(/\s+/g, ' ').trim() || null
    if (!name || !date) return // drop undated/nameless rows per skill rules
    events.push({ sourceId, slug: idMatch[2], name, date, location })
  })
  return events
}

async function fetchDetail(sourceId, slug) {
  const url = `${BASE_URL}/wydarzenie/${sourceId},${slug}`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) return { distances: null, isKids: false, regulaminUrl: null, website: null }
    const html = await res.text()
    const $ = cheerio.load(html)

    // .competitions .event rows: .item.distance + .item.kind ("Zawody dla dzieci")
    const distances = new Set()
    let isKids = false
    $('.competitions .event').each((_, el) => {
      const r = $(el)
      if (r.hasClass('headers')) return
      const d = cleanDistance(r.find('.item.distance').first().text())
      if (d) distances.add(d)
      if (/dzieci/i.test(r.find('.item.kind').first().text())) isKids = true
    })

    // Regulamin PDF (/files/_rules/<id>/<file>.pdf) — paths contain spaces, encode.
    let regulaminUrl = null
    $('a[href*="/files/_rules/"]').each((_, a) => {
      if (regulaminUrl) return
      const href = $(a).attr('href') || ''
      if (/\.pdf$/i.test(href)) regulaminUrl = encodeURI(BASE_URL + href)
    })

    // Organizer website — first external link that isn't the platform / fonts / social.
    let website = null
    $('a[href^="http"]').each((_, a) => {
      if (website) return
      const href = $(a).attr('href') || ''
      if (/zapisyonline\.pl|triso\.pl|googleapis|gstatic|skype|facebook|fb\.com|fb\.me|instagram|youtube/i.test(href)) return
      website = href
    })

    return {
      distances: distances.size ? [...distances].join(', ') : null,
      isKids,
      regulaminUrl,
      website,
    }
  } catch (err) {
    console.error(`[zapisyonline] Detail fetch failed for ${sourceId}:`, err.message)
    return { distances: null, isKids: false, regulaminUrl: null, website: null }
  }
}

async function scrape({ knownIds = new Set() } = {}) {
  // Collect listing across pages until a page yields no events.
  const listing = []
  const seen = new Set()
  for (let p = 0; p < MAX_PAGES; p++) {
    let html
    try {
      html = await fetchPage(p)
    } catch (err) {
      console.error(`[zapisyonline] Listing fetch failed:`, err.message)
      break
    }
    const pageEvents = parseListing(html).filter((e) => !seen.has(e.sourceId))
    if (pageEvents.length === 0) break
    for (const e of pageEvents) seen.add(e.sourceId)
    listing.push(...pageEvents)
    await new Promise((r) => setTimeout(r, 1100))
  }
  console.log(`[zapisyonline] Listing: ${listing.length} events parsed`)

  const running = listing.filter((e) => !NON_RUNNING_RE.test(e.name))
  console.log(`[zapisyonline] ${listing.length - running.length} non-running skipped`)

  // Emit only new events (timekeeper/bgtimesport pattern): we fetch detail only
  // for new rows, so re-emitting known rows would null their distances/website.
  const newEntries = running.filter((e) => !knownIds.has(e.sourceId))
  console.log(`[zapisyonline] ${newEntries.length} new (skipping ${running.length - newEntries.length} known)`)

  const results = []
  for (const entry of newEntries) {
    const sourceUrl = `${BASE_URL}/wydarzenie/${entry.sourceId},${entry.slug}`
    const detail = await fetchDetail(entry.sourceId, entry.slug)
    await new Promise((r) => setTimeout(r, 1100))
    console.log(`[zapisyonline] Detail ${results.length + 1}/${newEntries.length} — ${entry.name}`)

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
      is_kids: detail.isKids,
      event_types: eventTypes.length ? eventTypes : null,
      price_from: null,
      price_to: null,
      source: 'zapisyonline',
      source_id: entry.sourceId,
      source_url: sourceUrl,
    })
  }

  console.log(`[zapisyonline] Scraped ${results.length} events`)
  return results
}

export { scrape, parseListing, parseListingDate, cleanDistance, detectEventTypes }
