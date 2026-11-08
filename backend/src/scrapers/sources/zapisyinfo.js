import * as cheerio from 'cheerio'
import { pickRegulaminFromDom } from '../../lib/pickRegulaminUrl.js'
import { looksMultisport } from '../../lib/multisportEvent.js'

// zapisy.info — an online registration platform run by CMTECH (Django, built
// by webtechnika.pl) and used mostly by Kashubian / Pomorskie organizers: the
// whole "Kaszuby Biegają" cycle (Bieg Orłów, Sierakowicka Piętnastka, Bieg
// Stolemów, Krokowska 10, Grand Prix Powiatu Kościerskiego), the Wdzydze
// "Festiwal Biegów Polski Północnej", plus MTB Pomerania cycling races and
// the odd conference.
//
// Investigated 2026-11-08:
//   - No robots.txt (404) and no sitemap.xml (404). The site's regulamin
//     (/media/Regulamin_Zapisy02012026.pdf) has no clause about automated
//     access.
//   - /imprezy/ lists ONLY the events whose registration is open right now
//     (two on 2026-11-08: 720 and 732). /archiwum/ is empty, and the
//     /dyscypliny/<n>/ and /kategorie/<n>/ pages repeat the same open events.
//     So there is no listing of every upcoming event.
//   - Every event has a page /imprezy/<id>/ with sequential numeric ids
//     (700 = IX Cartusia Półmaraton, March 2026 … 762 = Biegi Wokół Ołtarza
//     Papieskiego, October 2026; 763+ answer 404). An event's id is assigned
//     when the organizer creates it, often months ahead: the 2026 Kaszuby
//     Biegają races (710-732) were all created in December 2025.
//
// So the scraper reads /imprezy/ for the open events and then walks a bounded
// window of ids: from LOOKBACK ids below the highest id it knows of (the
// highest stored source_id, the highest id on /imprezy/, or KNOWN_HIGH_ID)
// upwards, stopping after MAX_MISSES consecutive 404s above that highest id,
// and never fetching more than MAX_FETCHES pages. On 2026-11-08 that is ids
// 702-777, about 76 pages at 1.1 s each. Nothing scans thousands of ids.
//
// Event page fields (server-rendered, "Informacje podstawowe" block):
//   Miejsce: <strong>Grzybowski Młyn k. kościerzyny</strong>
//   Początek wydarzenia: <strong>15 listopada 2026 10:00</strong>
//   Rejestracja od: <strong>18 grudnia 2025 10:00</strong>
// While registration is open the page runs `runCountdown('2026-11-11T23:59')`
// under "Do końca rejestracji pozostało:", which is the registration deadline.
// "Zapisani zawodnicy do danego dystansu" lists one link per race
// (/imprezy/<id>/uczestnicy/dystans/<n>/) named "10 km", "10 km - opcja
// wirtualna", "Niedziela 1.6 km (14:30)", "Hard Runner"; distances come from
// those names and the event name. "Pliki do pobrania" links the regulamin as
// /media/regulations/<slug>.pdf ("Regulamin wydarzenia"), next to posters in
// /media/file/. The footer links the platform's own terms
// (/media/Regulamin_Zapisy02012026.pdf), so the picker only sees
// /media/regulations/. Prices are not on the page (they are in the regulamin)
// and are left to the enricher.
//
// registration_url — the event page itself, and only when it carries the
// "Zapisy" tab (/imprezy/<id>/rejestracja_do_imprezy/). Verified 2026-11-08
// with curl -sIL: /imprezy/720/ answers 200 directly and names the race;
// its Zapisy tab 302s to /accounts/login/?next=/imprezy/720/rejestracja_do_imprezy/,
// so the event id survives the login round trip, but the bare login page is
// not something to link. Events whose registration ended, and results-only
// events (761 Pomerania Ultra Trail, 762: zero races, no Zapisy tab), get no
// registration_url.
//
// Every field comes from a fresh fetch on every run and every upcoming event
// in the window is emitted, so re-emitting a known row cannot null anything.
// knownIds only moves the window.

const BASE_URL = 'https://zapisy.info'
const USER_AGENT = 'leszy.run/1.0 (lukasz@leszy.run)'
const DETAIL_DELAY_MS = 1100
export const KNOWN_HIGH_ID = 762
export const LOOKBACK = 60
export const MAX_MISSES = 15
export const MAX_FETCHES = 250

const NB = '[^a-ząćęłńóśźż]'

const MONTHS = {
  stycznia: 1, lutego: 2, marca: 3, kwietnia: 4, maja: 5, czerwca: 6,
  lipca: 7, sierpnia: 8, września: 9, wrzesnia: 9, października: 10, pazdziernika: 10,
  listopada: 11, grudnia: 12,
}

// Cycling, a conference, and the season passes of a cycle ("Cykl Kaszuby
// Biegają na 10 km 2026 - zapisy na całość", Miejsce "."), which sell entry
// to many races and are not an event on a day.
const NON_RUNNING_NAME = /rower|kolarsk|\bmtb\b|gravel|\bgrvl\b|\broad\s+race\b|szosow|enduro|p[lł]ywa|narciar|\bnarty\b|rolk|\bbike\b|konferencj|zapisy\s+na\s+ca[lł]o/i

export function isRunningEvent({ name, location }) {
  if (!name) return false
  if (looksMultisport({ name })) return false
  if (NON_RUNNING_NAME.test(name)) return false
  if (!location) return false
  return true
}

export function hasKidsSignal(text) {
  if (!text) return false
  const s = ` ${text.toLowerCase()} `
  if (/(?:biegi|bieg|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}przedszkol`).test(s)) return true
  if (/ma[lł]e\s+kaszuby/.test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

const STYLE_RULES = [
  ['trail', /g[oó]rsk|leśn|lesn|\btrail\b|cross(?:owy|owa|owe)?\b|przełaj|przelaj/],
  ['nordic walking', /nordic\s*walking|\bnw\b|marsz\s+z\s+kijami/],
  ['ocr', /\bocr\b/],
]

// Style from the umbrella name (adding-a-new-scraper 5b). A race name can add
// Nordic Walking only when the event name carries no style of its own.
export function detectEventTypes(name, races = []) {
  const n = (name || '').toLowerCase()
  const tags = []
  for (const [tag, re] of STYLE_RULES) if (re.test(n)) tags.push(tag)
  if (tags.length === 0 && races.some(r => STYLE_RULES[1][1].test(r.toLowerCase()))) tags.push('nordic walking')
  if (/\bultra\b/.test(n)) tags.push('ultra')
  if (/charytatywn/.test(n)) tags.push('charytatywny')
  return tags
}

function formatKm(value) {
  return `${Number(value.toFixed(4))} km`
}

// Every "<number> km" / "<number> m" in a label: "Niedziela 1.6 km (14:30)",
// "10 km - zawodnicy 70+", "Bieg Przedszkolaka 100 m". A bare number (a time,
// an age, "70+") is never a distance.
export function distancesFromLabel(label) {
  const out = []
  for (const m of (label || '').matchAll(/(\d+(?:[.,]\d+)?)\s*(km|m)(?![a-ząćęłńóśźż])/gi)) {
    const value = parseFloat(m[1].replace(',', '.'))
    if (!Number.isFinite(value) || value <= 0) continue
    if (m[2].toLowerCase() === 'km') {
      if (value <= 400) out.push(value)
    } else if (value >= 100) {
      out.push(value / 1000)
    }
  }
  return out
}

export function formatDistances(labels) {
  const values = [...new Set(labels.flatMap(distancesFromLabel))].sort((a, b) => a - b)
  if (values.length === 0) return null
  return values.map(v => (v < 1 ? `${Math.round(v * 1000)} m` : formatKm(v))).join(', ')
}

// "15 listopada 2026 10:00" → "2026-11-15".
export function parsePolishDate(text) {
  const m = (text || '').toLowerCase().match(/(\d{1,2})\s+([a-ząćęłńóśźż]+)\s+(\d{4})/)
  if (!m) return null
  const month = MONTHS[m[2]]
  if (!month) return null
  const day = Number(m[1])
  if (day < 1 || day > 31) return null
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim()
}

// The ids /imprezy/ links (events with registration open now).
export function parseListingIds(html) {
  const ids = new Set()
  for (const m of (html || '').matchAll(/href="\/imprezy\/(\d+)\/"/g)) ids.add(Number(m[1]))
  return [...ids].sort((a, b) => a - b)
}

// The sidebar's "Informacje podstawowe" list. The description above it can
// carry its own "<strong>Miejsce:</strong> Stadion …" line, so only the
// sidebar items are read.
function infoField($, label) {
  let value = null
  $('li.list-group-item').each((_, el) => {
    if (value !== null) return
    const item = $(el)
    if (clean(item.text()).startsWith(`${label}:`)) value = clean(item.find('strong').first().text()) || null
  })
  return value
}

// One /imprezy/<id>/ page → the fields of the event, or null when the page
// has no name or no parseable date.
export function parseEventPage(html, id) {
  const $ = cheerio.load(html || '')
  const title = clean($('title').first().text())
  const name = clean(title.replace(/^Informacje\s*-\s*/, '').replace(/\s*\|\s*Zapisy\.info.*$/i, ''))
  const date = parsePolishDate(infoField($, 'Początek wydarzenia'))
  if (!name || !date) return null
  const rawLocation = infoField($, 'Miejsce')
  const location = rawLocation && /[a-ząćęłńóśźż]/i.test(rawLocation) ? rawLocation : null

  const races = $(`a[href^="/imprezy/${id}/uczestnicy/dystans/"]`)
    .map((_, a) => clean($(a).text())).get().filter(Boolean)

  const hostsSignup = $(`a[href="/imprezy/${id}/rejestracja_do_imprezy/"]`).length > 0
  let deadline = null
  if (/Do końca rejestracji/i.test($('body').text())) {
    const m = (html || '').match(/runCountdown\('(\d{4}-\d{2}-\d{2})T/)
    if (m) deadline = m[1]
  }

  const regulaminUrl = pickRegulaminFromDom($, {
    selector: 'a[href*="/media/regulations/"]',
    baseUrl: BASE_URL,
  })

  return { id: String(id), name, date, location, races, hostsSignup, deadline, regulaminUrl }
}

export function buildRow(ev) {
  const eventUrl = `${BASE_URL}/imprezy/${ev.id}/`
  return {
    name: ev.name,
    date: ev.date,
    location: ev.location,
    distances: formatDistances([ev.name, ...ev.races]),
    registration_url: ev.hostsSignup ? eventUrl : null,
    registration_deadline: ev.deadline,
    regulamin_url: ev.regulaminUrl || null,
    website: null,
    is_kids: hasKidsSignal(ev.name) || ev.races.some(hasKidsSignal),
    event_types: detectEventTypes(ev.name, ev.races),
    price_from: null,
    price_to: null,
    source: 'zapisyinfo',
    source_id: ev.id,
    source_url: eventUrl,
  }
}

// The ids to fetch this run: the open events, then a window from LOOKBACK
// below the highest id known up to where MAX_MISSES consecutive 404s past it
// end the walk (the walk itself decides the end; this returns the start and
// the highest id).
export function walkPlan({ knownIds = new Set(), listingIds = [] } = {}) {
  const numeric = [...knownIds].map(Number).filter(Number.isInteger)
  const highest = Math.max(KNOWN_HIGH_ID, ...numeric, ...listingIds)
  return { start: Math.max(1, highest - LOOKBACK), highest }
}

async function fetchPage(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT } })
  if (res.status === 404) return { status: 404, text: null }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return { status: res.status, text: await res.text() }
}

function warsawToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(now)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function scrape({ knownIds = new Set() } = {}) {
  const results = []
  try {
    const listing = await fetchPage(`${BASE_URL}/imprezy/`)
    const listingIds = parseListingIds(listing.text)
    const { start, highest } = walkPlan({ knownIds, listingIds })
    const today = warsawToday()
    const events = new Map()
    let fetches = 0

    const visit = async (id) => {
      fetches++
      await sleep(DETAIL_DELAY_MS)
      const page = await fetchPage(`${BASE_URL}/imprezy/${id}/`)
      if (page.status === 404) return false
      const ev = parseEventPage(page.text, id)
      if (ev) events.set(ev.id, ev)
      return true
    }

    for (const id of listingIds) {
      if (id >= start) continue
      try { await visit(id) } catch (err) { console.log(`[zapisyinfo] ${id}: ${err.message}`) }
    }

    let misses = 0
    for (let id = start; fetches < MAX_FETCHES; id++) {
      let found
      try {
        found = await visit(id)
      } catch (err) {
        // A 5xx or a network error is not a missing id: it neither ends the
        // walk nor counts as a miss.
        console.log(`[zapisyinfo] ${id}: ${err.message}`)
        continue
      }
      misses = found ? 0 : misses + 1
      if (id > highest && misses >= MAX_MISSES) break
    }

    const upcoming = [...events.values()].filter(e => e.date >= today)
    const running = upcoming.filter(isRunningEvent)
    console.log(`[zapisyinfo] Read ${events.size} event pages (ids ${start}+, ${fetches} fetches), ${upcoming.length} upcoming, ${running.length} running`)
    for (const ev of running) results.push(buildRow(ev))
    console.log(`[zapisyinfo] Scraped ${results.length} events`)
  } catch (err) {
    console.error('[zapisyinfo] Scrape failed:', err.message)
  }
  return results
}

export { scrape }
