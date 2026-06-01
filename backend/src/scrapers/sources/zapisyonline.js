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
//
// Prices live one click deeper: every competition row has a "Zapisz się" button
// → /zapisy/<competitionId>,<slug>. That registration page lists one
// `.price.has` div per packet/wave (e.g. "159,00 zł") and, when a price tier has
// an expiry, a `.msg` "Powyższa cena obowiązuje do <DATE>". We follow every
// competition's Zapisz-się link, take the min/max across all packets as
// price_from/price_to, and the latest tier-expiry date as registration_deadline.
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

// event_type tags from a text blob — the umbrella name plus per-competition
// names (which often carry "Nordic walking" / "OCR" / trail signal the umbrella
// name omits). Mirrors distinguishingTags().
function detectEventTypes(text) {
  const blob = (text || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|leśn[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b/i.test(blob)) tags.add('ocr')
  return [...tags]
}

// Parse a /zapisy/<id>,<slug> registration page into prices + tier deadlines.
// `.price.has` divs carry the live price per packet ("159,00 zł"); `.msg` blocks
// carry "Powyższa cena obowiązuje do <YYYY-MM-DD>" when a tier expires.
function parseRegistrationPrices(html) {
  const $ = cheerio.load(html)
  const prices = []
  $('.price.has').each((_, el) => {
    const m = $(el).text().match(/(\d+(?:[.,]\d+)?)\s*zł/i)
    if (!m) return
    const n = parseFloat(m[1].replace(',', '.'))
    if (Number.isFinite(n) && n >= 0) prices.push(n)
  })
  const deadlines = []
  $('.msg').each((_, el) => {
    const m = $(el).text().match(/obowiązuje do\s*(\d{4}-\d{2}-\d{2})/i)
    if (m) deadlines.push(m[1])
  })
  return { prices, deadlines }
}

// Fetch every competition's /zapisy/ page and aggregate prices + deadline.
// price_from/price_to = min/max across all packets of all competitions;
// registration_deadline = the latest tier-expiry date seen (registration stays
// open through the final price tier). ISO dates compare correctly as strings.
async function fetchPrices(zapisyHrefs) {
  const prices = []
  const deadlines = []
  for (const href of zapisyHrefs) {
    try {
      const res = await fetch(BASE_URL + href, { headers: { 'User-Agent': USER_AGENT } })
      if (res.ok) {
        const { prices: p, deadlines: d } = parseRegistrationPrices(await res.text())
        prices.push(...p)
        deadlines.push(...d)
      }
    } catch (err) {
      console.error(`[zapisyonline] Price fetch failed for ${href}:`, err.message)
    }
    await new Promise((r) => setTimeout(r, 1100))
  }
  return {
    priceFrom: prices.length ? Math.min(...prices) : null,
    priceTo: prices.length ? Math.max(...prices) : null,
    registrationDeadline: deadlines.length ? deadlines.sort().at(-1) : null,
  }
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
    if (!res.ok) return { distances: null, competitionNames: [], isKids: false, regulaminUrl: null, website: null, priceFrom: null, priceTo: null, registrationDeadline: null }
    const html = await res.text()
    const $ = cheerio.load(html)

    // .competitions .event rows: .item.name (e.g. "Nordic walking", "Dzieci ...")
    // + .item.distance + .item.kind ("Zawody dla dzieci"), plus a "Zapisz się"
    // button (/zapisy/<id>,<slug>) we follow for prices. Competition names carry
    // event-type signal (Nordic Walking, OCR, trail) the umbrella name often omits.
    const distances = new Set()
    const competitionNames = []
    const zapisyHrefs = []
    let isKids = false
    $('.competitions .event').each((_, el) => {
      const r = $(el)
      if (r.hasClass('headers')) return
      const d = cleanDistance(r.find('.item.distance').first().text())
      if (d) distances.add(d)
      const cname = r.find('.item.name').first().text().replace(/\s+/g, ' ').trim()
      if (cname) competitionNames.push(cname)
      const kind = r.find('.item.kind').first().text()
      if (/dzieci/i.test(kind) || /dzieci/i.test(cname)) isKids = true
      const z = r.find('.item.btn a[href^="/zapisy/"]').first().attr('href')
      if (z) zapisyHrefs.push(z)
    })

    // Regulamin PDF (/files/_rules/<id>/<file>.pdf) — paths contain spaces, encode.
    let regulaminUrl = null
    $('a[href*="/files/_rules/"]').each((_, a) => {
      if (regulaminUrl) return
      const href = $(a).attr('href') || ''
      if (/\.pdf$/i.test(href)) regulaminUrl = encodeURI(BASE_URL + href)
    })

    // Organizer website — the dedicated "Oficjalna strona" (.item.www) block is
    // the organizer's DECLARED official link, so trust it as-is even when it's a
    // Facebook page (a valid official presence for many events); only reject the
    // platform's own / asset hosts. The fallback that scans arbitrary page links
    // additionally skips social, since there a Facebook hit is a share-widget
    // guess, not a declared link.
    const isPlatformHost = (href) => /zapisyonline\.pl|triso\.pl|googleapis|gstatic|skype/i.test(href)
    const isSocialHost = (href) => /facebook|fb\.com|fb\.me|instagram|youtube/i.test(href)
    let website = $('.item.www .value a[href^="http"]').first().attr('href') || null
    if (website && isPlatformHost(website)) website = null
    if (!website) {
      $('a[href^="http"]').each((_, a) => {
        if (website) return
        const href = $(a).attr('href') || ''
        if (isPlatformHost(href) || isSocialHost(href)) return
        website = href
      })
    }

    const { priceFrom, priceTo, registrationDeadline } = await fetchPrices(zapisyHrefs)

    return {
      distances: distances.size ? [...distances].join(', ') : null,
      competitionNames,
      isKids,
      regulaminUrl,
      website,
      priceFrom,
      priceTo,
      registrationDeadline,
    }
  } catch (err) {
    console.error(`[zapisyonline] Detail fetch failed for ${sourceId}:`, err.message)
    return { distances: null, competitionNames: [], isKids: false, regulaminUrl: null, website: null, priceFrom: null, priceTo: null, registrationDeadline: null }
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

    // Mine event types from competition names (catches a Nordic Walking / OCR
    // sub-race the umbrella name hides) — BUT only when the umbrella name itself
    // carries no style tag. If it already does (e.g. "Cross …" → trail), adding a
    // second style from a sub-race ({trail,nw}) would mismatch umbrella-only
    // aggregators ({trail}) and break the merge. See dedup.js hasDistinguishingConflict.
    const umbrellaTypes = detectEventTypes(entry.name)
    const eventTypes = umbrellaTypes.length
      ? umbrellaTypes
      : detectEventTypes([entry.name, ...(detail.competitionNames || [])].join(' '))
    results.push({
      name: entry.name,
      date: entry.date,
      location: entry.location,
      distances: detail.distances,
      registration_url: sourceUrl,
      registration_deadline: detail.registrationDeadline,
      regulamin_url: detail.regulaminUrl,
      website: detail.website,
      is_kids: detail.isKids,
      event_types: eventTypes.length ? eventTypes : null,
      price_from: detail.priceFrom,
      price_to: detail.priceTo,
      source: 'zapisyonline',
      source_id: entry.sourceId,
      source_url: sourceUrl,
    })
  }

  console.log(`[zapisyonline] Scraped ${results.length} events`)
  return results
}

export { scrape, parseListing, parseListingDate, cleanDistance, detectEventTypes, parseRegistrationPrices, fetchDetail }
