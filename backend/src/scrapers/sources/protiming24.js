import * as cheerio from 'cheerio'

const LISTING_URL = 'https://www.protiming24.pl/startmeta/'
const BASE_URL = 'https://www.protiming24.pl/startmeta'

// Skip virtual events (no physical race) — both checked against name and type hint.
const SKIP_VIRTUAL = /\bwirtu(alny|alne|alna|lne)\b/i

// Skip season passes — they duplicate the I/II/III/IV individual races on the
// same date but are a single registration product, not a separate event.
const SKIP_KARNET = /\bkarnet\b/i

function parseDateFromGoogleCal(href) {
  const m = href.match(/dates=(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

function parseLocationFromGoogleCal(href) {
  const m = href.match(/[?&]location=([^&]+)/)
  if (!m) return null
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() || null
  } catch {
    return null
  }
}

function parseDistances(typeHint) {
  if (!typeHint) return null
  const t = typeHint.replace(/ /g, ' ').trim()
  // "Bieg 2.5/5km" → ["2.5 km", "5 km"]
  const multi = t.match(/(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*km\b/i)
  if (multi) {
    return [multi[1], multi[2]]
      .map(d => `${d.replace(',', '.')} km`)
      .join(', ')
  }
  // Single distance: "Bieg na 5km", "Nordic Walking 7km", "Bieg Crossowy na 7km"
  const single = t.match(/(\d+(?:[.,]\d+)?)\s*km\b/i)
  if (single) return `${single[1].replace(',', '.')} km`
  return null
}

function isKidsHint(typeHint, name) {
  const t = (typeHint || '').toLowerCase()
  const n = (name || '').toLowerCase()
  if (/dzieci|małych|swietlik|świetlik/i.test(t)) return true
  if (/dzieci|małych żeglar|świetlik/i.test(n)) return true
  return false
}

// Tag detection from name + type hint. Returns null if no tags identified.
// Tags use the same vocabulary as biegiwpolsce/dostartu so the merger and
// downstream consumers see consistent values.
function detectEventTypes(name, typeHint) {
  const haystack = `${name || ''} ${typeHint || ''}`
  const tags = new Set()
  if (/nordic\s*walking|\bnw\b/i.test(haystack)) tags.add('nordic walking')
  if (/cross(owy|owa|owe)|\btrail\b/i.test(haystack)) tags.add('trail')
  if (/\bnocny\b|\bnocna\b|\bnocne\b/i.test(haystack)) tags.add('nocny')
  // 25h/24h/12h ultras and "RAZ Run" style endurance events
  if (/\b\d{1,3}\s*h\b|ultra/i.test(haystack)) tags.add('ultra')
  return tags.size > 0 ? [...tags] : null
}

async function scrape({ knownIds = new Set() } = {}) {
  let html
  try {
    const res = await fetch(LISTING_URL, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    html = await res.text()
  } catch (err) {
    console.error('[protiming24] Listing fetch failed:', err.message)
    return []
  }

  // Strip everything from "Wydarzenia archiwalne" onward. Archived events
  // produce result-page links, not registration links, and pollute results.
  const splitIdx = html.indexOf('Wydarzenia archiwalne')
  const upcomingHtml = splitIdx > 0 ? html.slice(0, splitIdx) : html
  const $ = cheerio.load(upcomingHtml)

  const events = []

  $('.vcard').each((_, el) => {
    const card = $(el)

    // Main event link: /startmeta/{HEX_ID}/
    const titleAnchor = card.find('h2.nomar a').first()
    const href = titleAnchor.attr('href')
    const rawName = (titleAnchor.attr('title') || titleAnchor.text() || '').trim()
    const name = rawName.replace(/\s+/g, ' ')
    if (!href || !name) return

    const idMatch = href.match(/\/startmeta\/([a-f0-9]+)\/?$/i)
    if (!idMatch) return
    const sourceId = idMatch[1].toLowerCase()

    // Date + location from the Google Calendar add-event link
    const calLink = card.find('a[href*="calendar.google.com"]').first()
    const calHref = calLink.attr('href') || ''
    const date = parseDateFromGoogleCal(calHref)
    const location = parseLocationFromGoogleCal(calHref)
    if (!date) return

    // Type/distance hint: text after "<city> · " in the small grey line
    const hintLine = card.find('div.text-size-09.push-10').first().text().replace(/ /g, ' ').trim()
    const middotIdx = hintLine.indexOf('·')
    const typeHint = middotIdx >= 0 ? hintLine.slice(middotIdx + 1).trim() : ''

    // Skip virtual races (no physical event to put on the calendar)
    if (SKIP_VIRTUAL.test(name) || SKIP_VIRTUAL.test(typeHint)) return
    // Skip season-pass listings — they duplicate individual races on same date
    if (SKIP_KARNET.test(name)) return

    const distances = parseDistances(typeHint)
    const isKids = isKidsHint(typeHint, name)
    const eventTypes = detectEventTypes(name, typeHint)

    // Registration URL only included when the listing renders a green
    // "Rejestracja" button — otherwise registration is closed.
    const regBtn = card.find('a.btn-success[href*="/registration/"]').first()
    const registrationUrl = regBtn.length ? regBtn.attr('href') : null

    events.push({
      name,
      date,
      location: location || null,
      distances,
      registration_url: registrationUrl,
      regulamin_url: `${BASE_URL}/${sourceId}/doc/regulamin`,
      website: null,
      is_kids: isKids,
      event_types: eventTypes,
      source: 'protiming24',
      source_id: sourceId,
      source_url: `${BASE_URL}/${sourceId}/`,
    })
  })

  const newCount = events.filter(e => !knownIds.has(e.source_id)).length
  console.log(`[protiming24] Scraped ${events.length} upcoming events (${newCount} new)`)
  return events
}

export { scrape }
