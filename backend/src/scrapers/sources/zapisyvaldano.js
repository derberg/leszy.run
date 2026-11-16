import * as cheerio from 'cheerio'

// zapisyvaldano.pl — "VALDANO | Organizacja Imprez Sportowych", a Laravel-based
// registration host that organizes and times its own events (Pomorskie /
// Kujawsko-Pomorskie heavy; currently the GRAND PRIX CROSS POLSKA series plus a
// few standalone runs). A direct organizer/timing co, so priority tier 3.
//
// Listing: /events (server-rendered, no pagination, future events only; ended /
// cancelled events live under /events/ended and /events/cancelled and are
// ignored). Each card exposes the name, the town and a /event/<id> detail link.
// Since a redesign (found 2026-11-16, the scraper had parsed nothing since June)
// the card shows only "13 gru", with no year, and the town as
// "Sztutowo, Ośrodek Bursztynowo" in span.truncate. The year comes from the
// detail page's "Początek wydarzenia" ("DD.MM.YYYY HH:MM").
//
// The host sometimes answers with a "One moment, please..." page that reloads
// itself after 5 s; the next requests get the real page. robots.txt allows
// everything. We wait as the page asks and try again, and fail loudly if it
// persists, so a dead source is an error in the run log, never "found 0".
//
// Detail page (/event/<id>) is the canonical registration landing page. The
// platform's own "Zapisz się" button points at /event/<id>/register, which 302s
// to a generic /login that DROPS the event id (verified with curl -sIL) — so it
// is NOT a usable registration URL. The public /event/<id> detail page carries
// every event-specific field, so we use it as registration_url and source_url.
//
// From the detail page we read:
//   - regulamin PDF: /event/<id>/rules/N (served inline as application/pdf;
//     verified it works without the ?t= cache-buster query, which we strip)
//   - prices: the structured "Cennik" block lists one price per competition per
//     date tier ("50 zł", "60 zł", "70 zł"); price_from/price_to = min/max. These
//     are real entry fees tied to competition names (Bieg / Marsz z kijami /
//     etc.), NOT charity "Pakiet N zł" donation tiers, so min/max is safe here.
//   - registration_deadline: the "Zamknięcie zapisów" value.
//   - competition names: feed event_types / is_kids detection.
//
// Distances are not on the page (they live in the regulamin PDF) → left null for
// the Python enricher to fill from the regulamin PDF. Voivodeship is not exposed → left for
// the geocoder. No event-specific organizer website on the page → left null.
const BASE_URL = 'https://zapisyvaldano.pl'
const LIST_URL = `${BASE_URL}/events`
const USER_AGENT = 'leszy.run/1.0 (lukasz@leszy.run)'

// Listing/detail dates are "DD.MM.YYYY HH:MM" (day may be single-digit, e.g.
// "9.08.2026"). Return YYYY-MM-DD or null.
function parseDate(raw) {
  if (!raw) return null
  const m = raw.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/)
  if (!m) return null
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

// event_type tags from a text blob — mirrors distinguishingTags(). NW also keys
// off the Polish "marsz z kijami" (literal Nordic Walking, how VALDANO labels its
// pole-walking sub-competitions) since the English regex won't catch it.
function detectEventTypes(text) {
  const blob = (text || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|leśn[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b|marsz\s+z\s+kijami/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b/i.test(blob)) tags.add('ocr')
  return [...tags]
}

// is_kids — true if the umbrella name or any competition name carries a kids
// signal. JS \b doesn't recognize Polish letters, so use a manual non-letter
// boundary.
const NB = '[^a-ząćęłńóśźż]'
function hasKidsSignal(text) {
  if (!text) return false
  const s = ` ${text.toLowerCase()} `
  if (/(?:biegi|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}świetlik`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

// Parse the /events listing into [{ sourceId, name, date, location }]. `date`
// is null when the card carries no year (the current layout); the detail page
// supplies it.
function parseListing(html) {
  const $ = cheerio.load(html)
  const events = []
  $('h2 a[href*="/event/"]').each((_, a) => {
    const href = $(a).attr('href') || ''
    const m = href.match(/\/event\/(\d+)(?:$|[?#])/)
    if (!m) return // skip /participants, /register, /rules links
    const sourceId = m[1]
    const name = $(a).text().replace(/\s+/g, ' ').trim()
    const card = $(a).closest('div.group')
    // Old layout: "DD.MM.YYYY HH:MM" in span.font-medium.
    const date = parseDate(card.find('span.font-medium').first().text())
    // Current layout: "Town, venue" in span.truncate. Old layout: a class-less
    // <span> in the location row.
    let location = null
    const truncate = card.find('span.truncate').first().text().replace(/\s+/g, ' ').trim()
    if (truncate) {
      location = truncate.split(',')[0].trim() || null
    } else {
      card.find('span:not([class])').each((_, s) => {
        if (location) return
        const t = $(s).text().replace(/\s+/g, ' ').trim()
        if (t && !/^\d/.test(t) && t !== '—') location = t
      })
    }
    if (!name) return
    events.push({ sourceId, name, date, location })
  })
  return events
}

// The "One moment, please..." interstitial the host serves now and then.
function isLoaderPage(html) {
  return /<title>\s*One moment, please/i.test(html || '')
}

// GET a page, waiting out the loader the way the page itself asks (reload after
// 5 s). Throws when the page never arrives.
async function fetchPage(url, { attempts = 4, waitMs = 6000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`)
    const html = await res.text()
    if (!isLoaderPage(html)) return html
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, waitMs))
  }
  throw new Error(`${url}: still the "One moment, please" loader after ${attempts} tries`)
}

const EMPTY_DETAIL = { competitionNames: [], regulaminUrl: null, priceFrom: null, priceTo: null, registrationDeadline: null, startDate: null }

// Parse the detail page for start date, prices, deadline, regulamin and
// competition names.
function parseDetail(html) {
  const $ = cheerio.load(html)

  // Prices: the structured Cennik block uses a distinctive price span
  // (text-rose-600 + font-semibold) holding "<int> zł" per competition/tier.
  // This class combo only appears on cennik prices — it skips the prose
  // "opłata podstawowa" / "opłata manipulacyjna" amounts in the description.
  const prices = []
  $('span').each((_, el) => {
    const cls = $(el).attr('class') || ''
    if (!/text-rose-600/.test(cls) || !/font-semibold/.test(cls)) return
    const m = $(el).text().match(/(\d+(?:[.,]\d+)?)\s*zł/i)
    if (!m) return
    const n = parseFloat(m[1].replace(',', '.'))
    if (Number.isFinite(n) && n >= 0) prices.push(n)
  })

  // Competition names: the price-row label span (text-gray-800) sitting next
  // to each price. Used for event_types / is_kids signal the umbrella hides.
  const competitionNames = []
  $('span').each((_, el) => {
    const cls = $(el).attr('class') || ''
    if (!/text-gray-800/.test(cls)) return
    // Only the ones inside a price row (sibling holds a "zł" price)
    const sib = $(el).parent().find('span.font-semibold')
    if (!sib.length || !/zł/i.test(sib.text())) return
    const t = $(el).text().replace(/\s+/g, ' ').trim()
    if (t) competitionNames.push(t)
  })

  // registration_deadline: value span following the "Zamknięcie zapisów" label.
  let registrationDeadline = null
  $('span').each((_, el) => {
    if (registrationDeadline) return
    if (/Zamknięcie zapisów/i.test($(el).text())) {
      registrationDeadline = parseDate($(el).next('span').text())
    }
  })

  // Start date: value span following the "Początek wydarzenia" label.
  let startDate = null
  $('span').each((_, el) => {
    if (startDate) return
    if (/^\s*Początek wydarzenia\s*$/i.test($(el).text())) {
      startDate = parseDate($(el).next('span').text())
    }
  })

  // Regulamin PDF — /event/<id>/rules/N. Strip the ?t= cache-buster query.
  let regulaminUrl = null
  const reg = $('a[href*="/rules/"]').first().attr('href')
  if (reg) regulaminUrl = reg.split('?')[0]

  return {
    competitionNames,
    regulaminUrl,
    priceFrom: prices.length ? Math.min(...prices) : null,
    priceTo: prices.length ? Math.max(...prices) : null,
    registrationDeadline,
    startDate,
  }
}

async function fetchDetail(sourceId) {
  try {
    return parseDetail(await fetchPage(`${BASE_URL}/event/${sourceId}`))
  } catch (err) {
    console.error(`[zapisyvaldano] Detail fetch failed for ${sourceId}:`, err.message)
    return EMPTY_DETAIL
  }
}

async function scrape({ knownIds = new Set() } = {}) {
  // A listing failure throws, so the run log records an error instead of a
  // quiet "found 0" (which hid this source for five months in 2026).
  const html = await fetchPage(LIST_URL)
  const listing = parseListing(html)
  if (!listing.length && /\/event\/\d+["?#]/.test(html)) {
    throw new Error('listing links events but none parsed: the page layout changed')
  }
  console.log(`[zapisyvaldano] Listing: ${listing.length} events parsed`)

  // Emit only new events (timekeeper/zapisyonline pattern): detail is fetched
  // only for new rows, so re-emitting known rows would null their prices /
  // regulamin. Known rows stay untouched until force re-scrape.
  const newEntries = listing.filter((e) => !knownIds.has(e.sourceId))
  console.log(`[zapisyvaldano] ${newEntries.length} new (skipping ${listing.length - newEntries.length} known)`)

  const results = []
  for (const entry of newEntries) {
    const sourceUrl = `${BASE_URL}/event/${entry.sourceId}`
    const detail = await fetchDetail(entry.sourceId)
    await new Promise((r) => setTimeout(r, 1100))
    console.log(`[zapisyvaldano] Detail ${results.length + 1}/${newEntries.length} — ${entry.name}`)
    const date = detail.startDate || entry.date
    if (!date) {
      console.warn(`[zapisyvaldano] ${entry.sourceId} skipped: no start date on the card or the detail page`)
      continue
    }

    // Mine event types from competition names (catches a Nordic Walking sub-race
    // the umbrella name hides) — BUT only when the umbrella itself carries no
    // style tag. If it already does (the GPCP "CROSS" series → trail), adding a
    // second style from a "Marsz z kijami" sub-race ({trail,nw}) would mismatch
    // umbrella-only aggregators ({trail}) and break the merge. See dedup.js
    // hasDistinguishingConflict.
    const umbrellaTypes = detectEventTypes(entry.name)
    const eventTypes = umbrellaTypes.length
      ? umbrellaTypes
      : detectEventTypes([entry.name, ...detail.competitionNames].join(' '))

    const isKids = hasKidsSignal([entry.name, ...detail.competitionNames].join(' '))

    results.push({
      name: entry.name,
      date,
      location: entry.location,
      distances: null, // in regulamin PDF only — left for the Python enricher
      registration_url: sourceUrl,
      registration_deadline: detail.registrationDeadline,
      regulamin_url: detail.regulaminUrl,
      website: null, // no event-specific organizer site on the page
      is_kids: isKids,
      event_types: eventTypes.length ? eventTypes : null,
      price_from: detail.priceFrom,
      price_to: detail.priceTo,
      source: 'zapisyvaldano',
      source_id: entry.sourceId,
      source_url: sourceUrl,
    })
  }

  console.log(`[zapisyvaldano] Scraped ${results.length} events`)
  return results
}

export { scrape, parseListing, parseDetail, parseDate, detectEventTypes, hasKidsSignal, fetchDetail, isLoaderPage }
