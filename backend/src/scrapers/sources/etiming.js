import * as cheerio from 'cheerio'
import { looksMultisport } from '../../lib/multisportEvent.js'

// etiming.pl — eTiming, a small timing company from Sandomierz (Świętokrzyskie
// and Podkarpacie: Sandomierz, Gorzyce, Chmielnik, Rymanów-Zdrój, Uścimów). It
// hosts its own registration for the races it times, plus a few cycling and
// motor events.
//
// Investigated 2026-11-18:
//   - etiming.pl is a Vue SPA; its HTML carries no event data. robots.txt is
//     `User-agent: * Allow: /`.
//   - The SPA reads a public JSON API with no authentication:
//       https://api.etiming.pl/events/?limit=12&offset=0
//         → { count, next, previous, results[] }, every event the company ever
//           listed (58 on 2026-11-18), newest first but not strictly ordered.
//           `next` comes back as http://, so it is rewritten to https.
//       https://api.etiming.pl/events/<slug>/  (trailing slash; without it 301)
//         → the event: name, subtitle, description (HTML), event_start (ISO
//           with offset), registration_close, city, lat/lng, status
//           (open / closed / full), distances[] (name, payment, price_tiers,
//           age_categories), details[] (the form's custom fields, e.g.
//           "Konkurencja: Bieg, Nordic Walking"), regulations_file (the
//           regulamin PDF the organizer uploaded under /regulations/, so the
//           field is regulamin-scoped and no picker is needed),
//           multi_distance_tiers (multi-stage packages).
//   - The listing alone decides which events are upcoming (event_start), so
//     only those details are fetched, a handful per run. Every upcoming event
//     is fetched again on each run and emitted whole, so re-emitting a known
//     one can never null a field; knownIds is accepted and ignored.
//
// registration_url — https://etiming.pl/e/<slug>/register. Verified 2026-11-18
// from the SPA's own code, not guessed: the router (assets/index-*.js) declares
// `/e/:slug/register` (RegisterView) and redirects `/event/:slug/register` to
// it, and the event page (EventView) renders its "Zapisz się" button with
// `to: /event/${slug}/register` only while `event.status` is neither `closed`
// nor `full`; RegisterView loads the event by slug from the same API and shows
// the form (no login) only when status is `open`. The SPA answers 200 for any
// path, a made-up slug included, so `curl -sIL` proves nothing here; the link
// is emitted only for an event whose API record says `status: open`, which is
// exactly when the site itself shows the button. A closed or full event gets
// none. Checked on ligatsa27 and ii-bieg-mikolajkowy (both open). Not checked
// by a person clicking it.
//
// The company also times enduro/motocross and cycling ("I ŻUPAWA ENDURO
// SPRINT", "12. Tropem Wilka i Rowerów Kilka", subtitle "Wyścig rowerowy"):
// isRunningEvent drops them by name and subtitle before any detail fetch.

const API_BASE = 'https://api.etiming.pl'
const LIST_URL = `${API_BASE}/events/?limit=50&offset=0`
const SITE = 'https://etiming.pl'
const USER_AGENT = 'leszy.run/1.0 (lukasz@leszy.run)'
const DETAIL_DELAY_MS = 1100
const MAX_PAGES = 20

const NB = '[^a-ząćęłńóśźż]'

const NON_RUNNING = new RegExp(
  [
    'rower', 'kolarsk', '\\bmtb\\b', 'gravel', 'szosow', '\\bbike',
    'enduro', 'motocyk', 'motocross', '\\bmx\\b', '\\bquad', 'p[lł]ywa', 'narciar',
    'rolk', 'orientac', 'psiak',
  ].join('|'),
  'i',
)
const WALKED = /\brajd|\bmarsz(?!obieg)|\bpiesz[ayeo]/i
const RACED = /\bbieg|nordic\s*walking|\bnw\b|\brun\b|\btrail\b|dycha/i

function text(...parts) {
  return parts.filter(Boolean).join(' ')
}

export function isRunningEvent({ name, subtitle } = {}) {
  if (!name) return false
  const blob = text(name, subtitle)
  if (NON_RUNNING.test(blob)) return false
  if (looksMultisport({ name: blob })) return false
  if (WALKED.test(blob) && !RACED.test(blob)) return false
  return true
}

const warsawDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' })
const warsawClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export function warsawDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return warsawDay.format(d)
}

// The last day a runner can register. A close at 00:00 Warsaw ("2026-12-01T00:00")
// ends registration as the 1st begins, so the 30th is the last day.
export function deadlineFrom(iso) {
  const day = warsawDate(iso)
  if (!day) return null
  if (warsawClock.format(new Date(iso)) !== '00:00') return day
  const prev = new Date(`${day}T12:00:00Z`)
  prev.setUTCDate(prev.getUTCDate() - 1)
  return prev.toISOString().slice(0, 10)
}

function formatKm(value) {
  return `${Number(value.toFixed(4))} km`
}

// Kilometres written as "26KM", "10 km", "7 kilometrów", "ok. 5 km".
function kmIn(s) {
  const out = []
  const re = /(\d+(?:[.,]\d+)?)\s*(?:km|kilometr[a-ząćęłńóśźż]*)(?![a-ząćęłńóśźż])/gi
  for (const m of (s || '').matchAll(re)) {
    const v = parseFloat(m[1].replace(',', '.'))
    if (Number.isFinite(v) && v > 0 && v <= 400) out.push(formatKm(v))
  }
  return out
}

function unique(list) {
  return [...new Set(list)]
}

// Only the description's own distance statements: the list under a heading or
// paragraph naming "dystans", and "trasa liczy / ma / o długości N km". The rest
// of the prose holds asides like "do 50 km od Sandomierza".
function distancesFromDescription(html) {
  if (!html) return []
  const $ = cheerio.load(html)
  const found = []
  $('p, h2, h3, h4').each((_, el) => {
    if (!/dystans/i.test($(el).text())) return
    const list = $(el).nextAll('ul').first()
    if (list.length) list.find('li').each((__, li) => { found.push(...kmIn($(li).text())) })
  })
  if (found.length) return found
  const body = $.root().text().replace(/\s+/g, ' ')
  for (const m of body.matchAll(/trasa\s+(?:liczy|ma|o\s+d[lł]ugo[sś]ci)\s+(?:ok\.\s*|około\s+)?(\d+(?:[.,]\d+)?\s*(?:km|kilometr[a-ząćęłńóśźż]*))/gi)) {
    found.push(...kmIn(m[1]))
  }
  return found
}

export function distancesFrom(event) {
  const fromNames = (event.distances || []).flatMap(d => kmIn(d.name))
  const list = unique(fromNames.length ? fromNames : distancesFromDescription(event.description))
  return list.length ? list.join(', ') : null
}

// Entry fees per start: each distance's payment, current price and price tiers.
// multi_distance_tiers and the event's top-level `payment` are left out: a
// season package (6 stages for 390 zł) buys several starts, not one.
export function pricesFrom(event) {
  const prices = []
  for (const d of event.distances || []) {
    for (const p of [d.payment, d.current_price, ...(d.price_tiers || []).map(t => t.price)]) {
      const v = parseFloat(p)
      if (Number.isFinite(v) && v > 0) prices.push(v)
    }
  }
  if (!prices.length) return { price_from: null, price_to: null }
  return { price_from: Math.round(Math.min(...prices)), price_to: Math.round(Math.max(...prices)) }
}

const STYLE_RULES = [
  ['trail', /g[oó]rsk|(?:^|[^a-ząćęłńóśźż])le[sś]n|\btrail\b|cross(?:owy|owa|owe)?\b|prze[lł]aj|terenow/],
  ['nordic walking', /nordic\s*walking|\bnw\b|marsz\s+z\s+kij/],
  ['ocr', /\bocr\b|przeszkod/],
]

// Style from the name and subtitle (the umbrella, adding-a-new-scraper 5b). The
// competitions (distance names and the "Konkurencja" form field) add Nordic
// Walking only when the umbrella carries no style of its own.
export function detectEventTypes(event) {
  const umbrella = text(event.name, event.subtitle).toLowerCase()
  const tags = []
  for (const [tag, re] of STYLE_RULES) if (re.test(umbrella)) tags.push(tag)
  if (tags.length === 0) {
    const competitions = text(
      ...(event.distances || []).map(d => d.name),
      ...(event.details || []).filter(f => /konkurencj|dyscyplin/i.test(f.name || '')).map(f => f.values),
    ).toLowerCase()
    if (STYLE_RULES[1][1].test(competitions)) tags.push('nordic walking')
  }
  if (/\bultra\b/.test(umbrella)) tags.push('ultra')
  if (/charytatywn/.test(umbrella)) tags.push('charytatywny')
  return tags
}

// Name, subtitle, distance names and age categories. Not the description, which
// mentions children in passing ("dzieci pod opieką rodziców").
export function hasKidsSignal(event) {
  const s = ` ${text(
    event.name, event.subtitle,
    ...(event.distances || []).flatMap(d => [d.name, ...(d.age_categories || []).map(a => a.name)]),
  ).toLowerCase()} `
  if (/(?:biegi|bieg|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

function coord(v) {
  const n = parseFloat(v)
  return Number.isFinite(n) && n !== 0 ? Number(n.toFixed(6)) : null
}

export function buildRow(event) {
  const date = warsawDate(event.event_start)
  if (!event.name || !date || !event.slug) return null
  const { price_from, price_to } = pricesFrom(event)
  const eventUrl = `${SITE}/e/${encodeURIComponent(event.slug)}`
  return {
    name: event.name.replace(/\s+/g, ' ').trim(),
    date,
    location: (event.city || '').trim() || null,
    distances: distancesFrom(event),
    registration_url: event.status === 'open' ? `${eventUrl}/register` : null,
    registration_deadline: deadlineFrom(event.registration_close),
    regulamin_url: event.regulations_file || null,
    website: null,
    is_kids: hasKidsSignal(event),
    event_types: detectEventTypes(event),
    price_from,
    price_to,
    lat: coord(event.lat),
    lng: coord(event.lng),
    source: 'etiming',
    source_id: event.slug,
    source_url: eventUrl,
  }
}

export function nextPageUrl(page) {
  if (!page?.next) return null
  let url
  try { url = new URL(page.next) } catch { return null }
  if (url.hostname !== new URL(API_BASE).hostname) return null
  url.protocol = 'https:'
  return url.toString()
}

export function upcomingSlugs(results, today) {
  const out = []
  for (const e of results) {
    const date = warsawDate(e.event_start)
    if (!e.slug || !date || date < today || out.includes(e.slug)) continue
    if (!isRunningEvent(e)) continue
    out.push(e.slug)
  }
  return out
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

async function scrape() {
  const results = []
  try {
    const listed = []
    let url = LIST_URL
    for (let i = 0; url && i < MAX_PAGES; i++) {
      const page = await fetchJson(url)
      listed.push(...(page.results || []))
      url = nextPageUrl(page)
    }
    const today = warsawDay.format(new Date())
    const slugs = upcomingSlugs(listed, today)
    console.log(`[etiming] Listed ${listed.length} events, ${slugs.length} upcoming running`)

    for (let i = 0; i < slugs.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, DETAIL_DELAY_MS))
      let event
      try {
        event = await fetchJson(`${API_BASE}/events/${encodeURIComponent(slugs[i])}/`)
      } catch (err) {
        console.log(`[etiming] ${slugs[i]}: detail unreadable (${err.message}), skipped`)
        continue
      }
      if (!isRunningEvent(event)) continue
      const row = buildRow(event)
      if (row) results.push(row)
    }
    console.log(`[etiming] Scraped ${results.length} events`)
  } catch (err) {
    console.error('[etiming] Scrape failed:', err.message)
  }
  return results
}

export { scrape }
