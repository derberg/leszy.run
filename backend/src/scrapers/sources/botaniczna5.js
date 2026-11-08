import * as cheerio from 'cheerio'
import { pickRegulaminUrl } from '../../lib/pickRegulaminUrl.js'
import { declaredVoivodeship } from '../../lib/polishLocation.js'

// botaniczna5.pl — "Botaniczna Piątka", one organizer's 5 km cross-country
// series run in botanical gardens in about a dozen Polish cities, in winter,
// spring, summer and autumn editions (plus a "Botanic Five" in Kaunas).
//
// Its timing partner plus-timing.pl lists each edition as ONE entry for the
// whole cycle with the date 0000-00-00, so the plustiming scraper drops it, and
// no single race of the series reached us from a timing platform.
//
// Two reads, both WordPress with the Events Manager plugin (the `event` post
// type is not exposed in wp-json, and there is no Events Calendar / tribe route):
//   /events.ics          upcoming events only: DTSTART, SUMMARY, URL, LOCATION
//                        ("venue, street, city, voivodeship, postcode, country")
//                        and GEO when the venue has coordinates
//   /events/<slug>/      the event page: "Zapisz się" button, the 5 km in
//                        .event-distance, the regulamin PDFs and a kids section
// The /aktualne-biegi/ listing shows the same events, but the theme dies with a
// PHP fatal error halfway down that page, so the iCal feed is the listing.
//
// source_id is the slug: the event names repeat per city, edition and year.
//
// registration_url — the event page's own "Zapisz się" button
// (.event-signup a). Verified 2026-11-07 with curl -sIL on
// plus-timing.pl/zgloszenia/botaniczna5-jesien-2026: one 301 to the trailing
// slash, then 200 with "Botaniczna Piątka 2026 - Edycja Jesienna", "Dystans:
// 5 km" and one button per city and date (15.11.2026 - Zielona Góra, ...).
// All cities of one edition share that url, because it is the cycle's form.
// Ruled out: the per-city index_f.php?edycja=<city> links on that page — they
// would have to be matched to our row by city name, i.e. reverse-engineered,
// while the button is what the source itself sends a runner to.
//
// regulamin_url — the page links the main-distance regulamin and the kids'
// one, both labelled "REGULAMIN ..." (CYKL-JESIEN-2026.pdf, DZIECI-JESIEN-2026.pdf),
// and the kids' one comes first. Kids documents are left out before the shared
// picker runs, so it picks the main one.
//
// Every upcoming event's page is read on every run (a handful at a time), so
// re-emitting a known row never nulls a field.

const BASE_URL = 'https://botaniczna5.pl'
const USER_AGENT = 'leszy.run/1.0 (lukasz@leszy.run)'

const KIDS_DOC = /dzieci|dzieci[eę]c|kids|vaik/i

function unfoldLines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n')
}

function unescapeIcs(value) {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim()
}

// LOCATION is one TEXT value whose commas are escaped ("OB Zielona Góra\\, ...").
function splitAddress(value) {
  return unescapeIcs(value).split(',').map(p => p.trim()).filter(Boolean)
}

// "Botaniczna Piątka Zielona Góra - edycja jesienna 2026" → "Zielona Góra"
export function cityFromName(name) {
  const m = (name || '').match(/Botaniczna\s+Pi[aą]tka\s+(.+?)\s+[-–]\s+edycja/i)
  return m ? m[1].trim() : null
}

// LOCATION "OB Zielona Góra, Botaniczna 50A, Zielona Góra, lubuskie, 65-392, Poland".
// The city is the part right before the voivodeship; without one, the name's city.
export function parseLocation(parts, name) {
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
  // Events Manager ends the address with the country when one is set.
  const country = parts.length >= 3 ? parts[parts.length - 1] : null
  return { city: city || cityFromName(name), voivodeship, country }
}

// Kaunas ("Botanic Five Kaunas") is in Lithuania. With no country in the
// address, a voivodeship or a Polish-series name still places it in Poland.
export function isInPoland(event) {
  if (event.country) return /^(poland|polska)$/i.test(event.country)
  return Boolean(event.voivodeship || cityFromName(event.name))
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
    const { city, voivodeship, country } = parseLocation(parts, name)
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

// "5 km" in .event-distance; normalised to "<n> km".
export function parseDistance(text) {
  const m = (text || '').match(/(\d+(?:[.,]\d+)?)\s*km/i)
  return m ? `${m[1].replace(',', '.')} km` : null
}

export function parseDetail(html, pageUrl) {
  const $ = cheerio.load(html)
  const signup = $('.event-signup a[href]').first().attr('href') || null
  const registrationUrl = signup ? new URL(signup, pageUrl).href : null

  const candidates = []
  $('a[href$=".pdf"], a[href*=".pdf?"]').each((_, el) => {
    const href = $(el).attr('href')
    const text = $(el).text()
    const file = href.split(/[?#]/)[0].split('/').pop() || ''
    if (KIDS_DOC.test(file) || KIDS_DOC.test(text)) return
    candidates.push({ href, text })
  })
  const regulaminUrl = pickRegulaminUrl(candidates, { baseUrl: pageUrl })

  const content = $('.entry-content').text().replace(/\s+/g, ' ')
  const isKids = $('a[href*="-dzieci"]').length > 0 || /biegi\s+dzieci[eę]c|bieg[ia]?\s+dla\s+dzieci/i.test(content)

  return {
    distances: parseDistance($('.event-distance').first().text()),
    registrationUrl,
    regulaminUrl,
    isKids,
  }
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
    website: null,
    is_kids: detail.isKids,
    // The names carry no style word; the series is cross-country but the
    // aggregators tag it from the name, so nothing is emitted (5b).
    event_types: [],
    price_from: null,
    price_to: null,
    lat: event.lat,
    lng: event.lng,
    source: 'botaniczna5',
    source_id: event.slug,
    source_url: event.url,
  }
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

export async function scrape() {
  const results = []
  try {
    const events = parseIcs(await fetchText(`${BASE_URL}/events.ics`))
    const today = new Date().toISOString().slice(0, 10)
    // The virtual edition ("edycja wirtualna", slug "wirtulna") is no race.
    const kept = events.filter(e =>
      e.date >= today && isInPoland(e) && !/wirtu/i.test(`${e.name} ${e.slug}`))
    console.log(`[botaniczna5] Found ${events.length} events, ${kept.length} upcoming in Poland`)

    for (const event of kept) {
      try {
        const html = await fetchText(event.url)
        results.push(buildRow(event, parseDetail(html, event.url)))
      } catch (err) {
        // A row without its page would null the stored registration url and
        // regulamin. Skip it; the next run reads it again.
        console.log(`[botaniczna5] ${event.slug}: event page unreadable (${err.message}), skipped`)
      }
      await new Promise(r => setTimeout(r, 1100))
    }
    console.log(`[botaniczna5] Scraped ${results.length} events with details`)
  } catch (err) {
    console.error('[botaniczna5] Scrape failed:', err.message)
  }
  return results
}
