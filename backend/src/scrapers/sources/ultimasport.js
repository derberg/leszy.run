import * as cheerio from 'cheerio'
import { pickRegulaminFromDom } from '../../lib/pickRegulaminUrl.js'
import { looksMultisport } from '../../lib/multisportEvent.js'

// ultimasport.pl — Ultimasport, a timing company from Dolny Śląsk (Strzelin,
// Ząbkowice, Wałbrzych, the Sudety). It times road races, mountain races and
// long mountain rajdy, and also MTB, triathlon, swimming and roller events. It
// hosts its own registration system at formularz.ultimasport.pl/<id>.
//
// Investigated 2026-11-08:
//   - ultimasport.pl is WordPress, but no WP REST route or iCal feed carries
//     the events. The page /zapisy/ holds one server-rendered table with every
//     form the company ever opened (463 rows, past ones included): date, town,
//     name, each cell linking to https://formularz.ultimasport.pl/<id>. So one
//     request gives the date, the town and the name of every event, and the
//     listing alone decides which events are upcoming.
//   - formularz.ultimasport.pl/<id> (an ASP.NET app, not WordPress) is the
//     event's page: an <h1> "<name>, <town>", the "Zapisz się na zawody"
//     button, a "Regulamin" button to uploads/regulations/<id>_<file>.pdf and a
//     table of entrants per classification. The classification rows (after the
//     "classification stats" comment) are the races: "27 km", "5KM",
//     "Nordic Walking - 5 km", "1918 m". Fees and the deadline sit behind the
//     login, so they are left to the enricher.
//   - robots.txt disallows only /wp-admin/. formularz.ultimasport.pl has no
//     robots.txt rules of its own.
//   - The regulamin (content.ultimasport.pl/regulaminy/regulamin_ultimasport.pdf)
//     §3 ust. 6 and §9 ust. 3 restrict reuse of the site's content and
//     databases. The operator decided on 2026-11-08 to scrape anyway, because
//     robots.txt does not exclude it; only public listing facts are read.
//
// registration_url — the formularz.ultimasport.pl/<id> link the listing itself
// gives a runner. Its "Zapisz się" button goes to /Competitor/Form/
// LoginDecision?formId=<id>, which keeps the form id through the login. The
// page is fetched for every row and the row is emitted only when its <h1> names
// the event (pageNamesEvent), so a recycled or broken form id never becomes a
// link. Verified 2026-11-08 with curl on 490, 501, 518: 200, no redirect, the
// <h1> carries the event name. A form whose sign-up has closed ("Zapisy na
// zawody są obecnie zamknięte!") still links there: it is the event's only page.
//
// The listing mixes in cycling, MTB, triathlon, swimming, ski, roller,
// orienteering and motor events, and walked rajdy and marsze (10 h limits,
// "Rajd Górski", "Marsz Górski", Silesian "Rajza"): isRunningEvent drops them
// by name before any detail page is fetched. Nordic walking and marszobieg
// are kept.
//
// Every upcoming event is fetched again on every run (about a dozen), so all
// of them are emitted each time and re-emitting a known one cannot null a
// field. A form page that does not answer skips its row for that run. knownIds
// is accepted and ignored.

const LISTING_URL = 'https://ultimasport.pl/zapisy/'
const FORM_HOST = 'https://formularz.ultimasport.pl'
const USER_AGENT = 'leszy.run/1.0 (lukasz@leszy.run)'
const DETAIL_DELAY_MS = 1100

const NB = '[^a-ząćęłńóśźż]'

// Disciplines that are not running. "xc" is MTB cross-country on this site
// (XC KUDOWA, Puchar Piaseczna XC); quad, 4x4 and wrak race are motor events.
const NON_RUNNING_NAME = new RegExp(
  [
    'rower', 'kolarsk', '\\bmtb\\b', '\\bxc\\b', 'gravel', 'szosow', '\\bbike',
    'p[lł]ywa', 'narciar', '\\bnarty\\b', 'rolk', 'roller', '\\broll\\b',
    'orientac', '\\bbno\\b', '\\bquad\\b', '4x4', 'wrak\\s+race', 'jazda\\s+pod\\s+zegarem',
  ].join('|'),
  'i',
)

// Walked events: rajd / rajza (Silesian for rajd), marsz, maraton pieszy,
// tułaczka, dreptanie, szwendaczka. Marszobieg is a run-walk race and stays.
const WALKED_NAME = /\brajd|\brajz[aey]|\bmarsz(?!obieg)|\bpiesz(?:y|a|e|o|ym|ej|ych|ymi|emu|ego)\b|tu[lł]aczk|dreptani|szwendacz/i
const RACED_NAME = /\bbieg|nordic\s*walking|\bnw\b|z\s+kijami|\brun\b|\btrail\b|uphill/i

export function isRunningEvent({ name } = {}) {
  if (!name) return false
  if (NON_RUNNING_NAME.test(name)) return false
  if (looksMultisport({ name })) return false
  if (WALKED_NAME.test(name) && !RACED_NAME.test(name)) return false
  return true
}

export function hasKidsSignal(text) {
  if (!text) return false
  const s = ` ${text.toLowerCase()} `
  if (/(?:biegi|bieg|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

const STYLE_RULES = [
  // leśn only at the start of a word: OLEŚNICKI BIEG NIEPODLEGŁOŚCI is a street
  // race in Oleśnica, not a forest one.
  ['trail', /g[oó]rsk|(?:^|[^a-ząćęłńóśźż])le[sś]n|\btrail\b|cross(?:owy|owa|owe)?\b|przełaj|przelaj/],
  ['nordic walking', /nordic\s*walking|\bnw\b|marsz\s+z\s+kijami/],
  ['ocr', /\bocr\b|przeszkod/],
]

// Style from the umbrella name (adding-a-new-scraper 5b). A classification can
// add Nordic Walking only when the name carries no style of its own, so the row
// never holds two styles an umbrella-only aggregator row would not.
export function detectEventTypes(name, classifications = []) {
  const n = (name || '').toLowerCase()
  const tags = []
  for (const [tag, re] of STYLE_RULES) if (re.test(n)) tags.push(tag)
  if (tags.length === 0 && classifications.some(c => STYLE_RULES[1][1].test(c.toLowerCase()))) {
    tags.push('nordic walking')
  }
  if (/\bultra\b/.test(n)) tags.push('ultra')
  if (/charytatywn/.test(n)) tags.push('charytatywny')
  return tags
}

function formatKm(value) {
  return `${Number(value.toFixed(4))} km`
}

// "27 km", "5KM", "Nordic Walking - 5 km", "1918 m". A label with no number
// and unit ("Bieg", "Bieg na Wieżę") is no distance.
export function distanceFromLabel(label) {
  const m = (label || '').match(/(\d+(?:[.,]\d+)?)\s*(km|m)(?![a-ząćęłńóśźż])/i)
  if (!m) return null
  const value = parseFloat(m[1].replace(',', '.'))
  if (!Number.isFinite(value) || value <= 0) return null
  if (m[2].toLowerCase() === 'km') return value <= 400 ? formatKm(value) : null
  if (value < 100) return null
  return value >= 1000 ? formatKm(value / 1000) : `${value} m`
}

export function distancesFrom(classifications) {
  const out = []
  for (const c of classifications) {
    const d = distanceFromLabel(c)
    if (d && !out.includes(d)) out.push(d)
  }
  return out.length ? out.join(', ') : null
}

function clean(text) {
  return (text || '').replace(/\s+/g, ' ').trim()
}

// The /zapisy/ table: <tr class='clickable'><td>date</td><td>town</td><td>name</td></tr>,
// every cell an <a> to formularz.ultimasport.pl/<id>.
export function parseListing(html) {
  const $ = cheerio.load(html)
  const rows = []
  const seen = new Set()
  $('tr').each((_, tr) => {
    const cells = $(tr).find('td')
    if (cells.length < 3) return
    const href = $(cells[0]).find('a').attr('href') || $(tr).find('a[href]').first().attr('href') || ''
    const m = href.match(/^https?:\/\/formularz\.ultimasport\.pl\/(\d+)\/?$/)
    if (!m || seen.has(m[1])) return
    const date = clean($(cells[0]).text())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return
    const name = clean($(cells[2]).text())
    if (!name) return
    seen.add(m[1])
    rows.push({ id: m[1], date, location: clean($(cells[1]).text()) || null, name })
  })
  return rows
}

// The form page: the <h1> title, the classification rows of the entrants table
// and the regulamin button.
export function parseForm(html, formUrl) {
  const $ = cheerio.load(html)
  const title = clean($('h1').first().text())
  const classifications = []
  const tbody = $('table').first().find('tbody').html() || ''
  const marker = tbody.indexOf('classification stats')
  if (marker >= 0) {
    const $c = cheerio.load(`<table><tbody>${tbody.slice(marker)}</tbody></table>`)
    $c('tr').each((_, tr) => {
      const label = clean($c(tr).find('td').first().text())
      if (label) classifications.push(label)
    })
  }
  const regulaminUrl = pickRegulaminFromDom($, { selector: 'a[href*="uploads/regulations/"]', baseUrl: formUrl })
  const closed = /zapisy na zawody s[aą] obecnie zamkni/i.test($('body').text())
  return { title, classifications, regulaminUrl, closed }
}

function words(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFC')
    .split(/[^a-z0-9ąćęłńóśźż]+/)
    .filter(w => w.length >= 4 && !/^\d+$/.test(w))
}

// The form's <h1> is "<name>, <town>". It names the event when it shares a
// word of four letters or more with the listing name (or, for a name of short
// words only, contains it whole).
export function pageNamesEvent(title, name) {
  const t = (title || '').toLowerCase()
  const ws = words(name)
  if (ws.length === 0) return t.includes(clean(name).toLowerCase())
  return ws.some(w => t.includes(w))
}

export function buildRow(event, form) {
  const formUrl = `${FORM_HOST}/${event.id}`
  const blob = [event.name, ...form.classifications].join(' ')
  return {
    name: event.name,
    date: event.date,
    location: event.location,
    distances: distancesFrom(form.classifications),
    registration_url: formUrl,
    registration_deadline: null,
    regulamin_url: form.regulaminUrl || null,
    website: null,
    is_kids: hasKidsSignal(blob),
    event_types: detectEventTypes(event.name, form.classifications),
    price_from: null,
    price_to: null,
    source: 'ultimasport',
    source_id: event.id,
    source_url: formUrl,
  }
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return { text: await res.text(), url: res.url || url }
}

function warsawToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(now)
}

async function scrape() {
  const results = []
  try {
    const { text } = await fetchText(LISTING_URL)
    const today = warsawToday()
    const upcoming = parseListing(text).filter(e => e.date >= today)
    const running = upcoming.filter(e => isRunningEvent(e))
    console.log(`[ultimasport] Found ${upcoming.length} upcoming events, ${running.length} running`)

    for (let i = 0; i < running.length; i++) {
      const event = running[i]
      if (i > 0) await new Promise(r => setTimeout(r, DETAIL_DELAY_MS))
      const formUrl = `${FORM_HOST}/${event.id}`
      let form
      try {
        const page = await fetchText(formUrl)
        if (new URL(page.url).host !== new URL(FORM_HOST).host) throw new Error(`redirected to ${page.url}`)
        form = parseForm(page.text, formUrl)
      } catch (err) {
        console.log(`[ultimasport] ${event.id}: form page unreadable (${err.message}), skipped`)
        continue
      }
      if (!pageNamesEvent(form.title, event.name)) {
        console.log(`[ultimasport] ${event.id}: form page does not name "${event.name}" (h1: "${form.title}"), skipped`)
        continue
      }
      results.push(buildRow(event, form))
    }
    console.log(`[ultimasport] Scraped ${results.length} events`)
  } catch (err) {
    console.error('[ultimasport] Scrape failed:', err.message)
  }
  return results
}

export { scrape }
