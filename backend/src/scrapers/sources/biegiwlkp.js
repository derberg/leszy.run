import * as cheerio from 'cheerio'
import { pickRegulaminUrl } from '../../lib/pickRegulaminUrl.js'
import { declaredVoivodeship } from '../../lib/polishLocation.js'

// biegiwlkp.pl — "Biegi.Wlkp" (Stowarzyszenie Biegiemwlas, Poznań). Its own
// calendar of the cross-country runs it organises in Wielkopolska: the
// Marcelin and Puszczykowo cycles, the Poznańska Triada Biegowa (Bieg
// Niepodległości, Bieg Noworoczny), the Łękno half marathon. A handful of
// upcoming races at a time. Checked 2026-11-07: robots.txt disallows only
// /wp-admin/, and neither the footer nor /kontakt/ restricts reuse.
//
// Same theme and plugin as botaniczna5.pl (WordPress + Events Manager: the
// `event` post type is not exposed in wp-json, no tribe route). Two reads:
//   /events.ics          upcoming events only: DTSTART, SUMMARY, URL, LOCATION
//                        ("venue, street, city, voivodeship, postcode, country",
//                        the voivodeship and postcode often missing) and GEO
//   /events/<slug>/      the event page: "Zapisz się" button (.event-signup),
//                        the distances (.event-distance, "5/10 km"), the
//                        regulamin PDFs and the kids forms
// /aktualne-biegi/ lists the same events; the feed is easier to parse.
//
// source_id is the slug from /events/<slug>/.
//
// registration_url — the page's own "Zapisz się" button. It points at the
// timing partner's form, plus-timing.pl/zgloszenia/<cycle>. Verified
// 2026-11-07 with curl -sIL: cykl-puszczykowo-2026 → 301 to the trailing slash
// → 200 "#biegiemwlas 2026 Puszczykowo - Zgłoszenia" listing "Bieg po Ciacho -
// 29.11.2026"; poznanska-triada-biegowa-2027 → 301 → 200 "Poznańska Triada
// Biegowa - Zgłoszenia" listing "Noworoczny - 3.01.2027"; cykl-marcelin-2026 →
// 301 → 302 t_k.php → 200 "#biegiemwlas 2026 w Lasku Marcelińskim". One form
// can serve several races of a cycle, as on botaniczna5. Before a form exists
// the button points at the bare results page (plus-timing.pl/wyniki, the same
// href as the "Wyniki" button); that is no sign-up page, so it gives null.
//
// website — the event page itself: Biegi.Wlkp is the organiser, not an
// aggregator, so its page is the organiser's page for the race.
//
// regulamin_url — the page links the main regulamin and, for races with kids'
// runs, the kids' one (plus-timing.pl/zgloszenia/<x>-dzieci/doc/regulamin.pdf,
// whose file name outscores the main "Puszczykowo_cykl.pdf" labelled
// "REGULAMIN BIEGU GŁÓWNEGO"). Kids documents are left out before the shared
// picker runs. Informators, the pick-up authorisation and maps never qualify.
//
// Every upcoming event's page is read on every run (a handful), so
// re-emitting a known row never nulls a field.

const BASE_URL = 'https://biegiwlkp.pl'
const USER_AGENT = 'leszy.run/1.0 (lukasz@leszy.run)'

const KIDS_DOC = /dzieci|dzieci[eę]c|kids/i
const NOT_RUNNING = /rower|kolarsk|\bmtb\b|rolk|p[lł]ywan|triathlon|duathlon|wirtu/i
const POSTCODE = /^\d{2}-\d{3}$/
const POLAND = /^(poland|polska)$/i
// Events Manager ends the address with the country when the venue has one.
const COUNTRY = /^(poland|polska|germany|niemcy|lithuania|litwa|czech republic|czechia|czechy|slovakia|s[lł]owacja|ukraine|ukraina)$/i

function unfoldLines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n')
}

function unescapeIcs(value) {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim()
}

// LOCATION is one TEXT value whose commas are escaped ("Lasek Marceliński\\, ...").
function splitAddress(value) {
  return unescapeIcs(value).split(',').map(p => p.trim()).filter(Boolean)
}

// "Lasek Marceliński, Ptasia, Poznań, wielkopolskie, Poland"   → Poznań
// "Puszczykowo, Kościelna 7, Puszczykowo, Puszczykowo, wielkopolskie, 62-640, Poland"
// "Jezioro Rusałka, Jezioro Rusałka, Poznań, Poland"           → Poznań
// The city is the part right before the voivodeship; without one, the last
// part once the country and postcode are dropped.
export function parseLocation(parts) {
  let city = null
  let voivodeship = null
  for (let i = 0; i < parts.length; i++) {
    const v = declaredVoivodeship(parts[i])
    if (v && parts[i].trim().toLowerCase() === v.toLowerCase()) {
      voivodeship = v
      if (i > 0) city = parts[i - 1]
      break
    }
  }
  const last = parts[parts.length - 1]
  const country = parts.length >= 2 && COUNTRY.test(last) ? last : null
  if (!city) {
    const rest = parts.filter(p => !POSTCODE.test(p) && p !== country)
    if (rest.length >= 2) city = rest[rest.length - 1]
  }
  return { city, voivodeship, country }
}

export function parseIcs(text) {
  const events = []
  for (const block of text.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0]
    const fields = {}
    for (const line of unfoldLines(body)) {
      const m = line.match(/^([A-Z-]+)(?:;[^:]*)?:(.*)$/)
      if (m && !(m[1] in fields)) fields[m[1]] = m[2]
    }
    const dt = (fields.DTSTART || '').match(/^(\d{4})(\d{2})(\d{2})/)
    const url = (fields.URL || '').trim()
    const slug = url.match(/\/events\/([^/]+)\/?$/)?.[1]
    const name = unescapeIcs(fields.SUMMARY || '')
    if (!dt || !slug || !name) continue
    const parts = fields.LOCATION ? splitAddress(fields.LOCATION) : []
    const { city, voivodeship, country } = parseLocation(parts)
    let lat = null
    let lng = null
    const geo = (fields.GEO || '').match(/^(-?\d+(?:\.\d+)?);(-?\d+(?:\.\d+)?)$/)
    if (geo) {
      const la = Number(geo[1])
      const lo = Number(geo[2])
      if (la !== 0 || lo !== 0) {
        lat = Math.round(la * 1e6) / 1e6
        lng = Math.round(lo * 1e6) / 1e6
      }
    }
    events.push({
      slug,
      url,
      name,
      date: `${dt[1]}-${dt[2]}-${dt[3]}`,
      city,
      voivodeship,
      country,
      lat,
      lng,
    })
  }
  return events
}

export function isInPoland(event) {
  return !event.country || POLAND.test(event.country)
}

// ".event-distance": "10 km", "5/10 km", "10,5 km / 21,1 km", "400 m / 5 km".
// A number without its own unit takes the next unit written after it.
export function parseDistances(text) {
  const s = (text || '').replace(/\s+/g, ' ')
  const tokens = [...s.matchAll(/(\d+(?:[.,]\d+)?)\s*(km|m)?(?![a-ząćęłńóśźż])/gi)]
  if (tokens.length === 0) return null
  const out = []
  let pendingUnit = null
  for (let i = tokens.length - 1; i >= 0; i--) {
    const unit = tokens[i][2] ? tokens[i][2].toLowerCase() : pendingUnit
    if (tokens[i][2]) pendingUnit = unit
    if (!unit) continue
    out.unshift(`${tokens[i][1].replace(',', '.')} ${unit}`)
  }
  const unique = [...new Set(out)]
  return unique.length ? unique.join(', ') : null
}

// The button's href is the sign-up page, unless it only points at a generic
// results page (what the theme shows before the form is open).
export function signupUrl($, pageUrl) {
  const href = $('.event-signup a[href]').first().attr('href')
  if (!href) return null
  let url
  try {
    url = new URL(href, pageUrl)
  } catch {
    return null
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (path === '' || /^\/(wyniki|results?)$/i.test(path)) return null
  const resultsHrefs = $('a[href]').filter((_, el) => /^\s*wyniki\s*$/i.test($(el).text())).map((_, el) => $(el).attr('href')).get()
  if (resultsHrefs.includes(href)) return null
  return url.href
}

export function parseDetail(html, pageUrl) {
  const $ = cheerio.load(html)

  const candidates = []
  $('a[href$=".pdf"], a[href*=".pdf?"]').each((_, el) => {
    const href = $(el).attr('href')
    const text = $(el).text()
    if (KIDS_DOC.test(href) || KIDS_DOC.test(text)) return
    candidates.push({ href, text })
  })
  const regulaminUrl = pickRegulaminUrl(candidates, { baseUrl: pageUrl })

  const content = $('.entry-content').text().replace(/\s+/g, ' ')
  const isKids = $('.entry-content a[href*="-dzieci"]').length > 0 ||
    /biegi\s+dzieci[eę]c|bieg[ia]?\s+dla\s+dzieci|formularz zg[lł]oszeniowy\s*[-–]\s*dzieci/i.test(content)

  return {
    distances: parseDistances($('.event-distance').first().text()),
    registrationUrl: signupUrl($, pageUrl),
    regulaminUrl,
    isKids,
  }
}

// Style from the name only (5b); the race names here rarely carry one.
export function detectEventTypes(name) {
  const blob = (name || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|leśn[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b|marsz\s+z\s+kijami/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b/i.test(blob)) tags.add('ocr')
  return [...tags]
}

export function buildRow(event, detail) {
  return {
    name: event.name,
    date: event.date,
    location: event.city,
    voivodeship: event.voivodeship,
    distances: detail.distances,
    registration_url: detail.registrationUrl,
    registration_deadline: null,
    regulamin_url: detail.regulaminUrl,
    website: event.url,
    is_kids: detail.isKids,
    event_types: detectEventTypes(event.name),
    price_from: null,
    price_to: null,
    lat: event.lat,
    lng: event.lng,
    source: 'biegiwlkp',
    source_id: event.slug,
    source_url: event.url,
  }
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

// knownIds is accepted but unused: every upcoming page is re-read.
export async function scrape() {
  const results = []
  try {
    const events = parseIcs(await fetchText(`${BASE_URL}/events.ics`))
    const today = new Date().toISOString().slice(0, 10)
    const kept = events.filter(e => e.date >= today && isInPoland(e) && !NOT_RUNNING.test(`${e.name} ${e.slug}`))
    console.log(`[biegiwlkp] Found ${events.length} events, ${kept.length} upcoming running events`)

    for (const event of kept) {
      try {
        const html = await fetchText(event.url)
        results.push(buildRow(event, parseDetail(html, event.url)))
      } catch (err) {
        // A row without its page would null the stored registration url and
        // regulamin. Skip it; the next run reads it again.
        console.log(`[biegiwlkp] ${event.slug}: event page unreadable (${err.message}), skipped`)
      }
      await new Promise(r => setTimeout(r, 1100))
    }
    console.log(`[biegiwlkp] Scraped ${results.length} events with details`)
  } catch (err) {
    console.error('[biegiwlkp] Scrape failed:', err.message)
  }
  return results
}
