import * as cheerio from 'cheerio'
import { pickRegulaminFromDom } from '../../lib/pickRegulaminUrl.js'
import { looksMultisport } from '../../lib/multisportEvent.js'

// sts-timing.pl — STS-Timing (Toruń), a timing company working nationwide:
// city races (Bieg Niepodległości in Warszawa, Gdynia, Kraków), charity runs,
// triathlons, MTB and road cycling. It hosts its own registration system at
// zapisy.sts-timing.pl/<id>/. Several of its races (Półmaraton Polkowicki,
// XI Janikowska ZaDyszka, X Bieg STO-nogi) were listed by biegiwpolsce.pl and
// by nothing else we scrape, so dropping biegiwpolsce (#415) lost them.
//
// WordPress with the EventON calendar plugin. Investigated 2026-11-07:
//   - /wp-json/wp/v2/ajde_events lists every event (418, past ones included)
//     with its event_type taxonomy, but NOT the date: EventON keeps it in post
//     meta (evcal_srow) that the REST route does not expose.
//   - The calendar page /wydarzenia/ loads its events over EventON's own AJAX
//     endpoint, POST /?evo-ajax=eventon_get_events, which needs the public
//     nonce printed in that page (evo_general_params.n). One call returns every
//     event in a date range: the JSON half carries the ids and meta, the HTML
//     half the event cards the calendar shows (start date in schema.org meta,
//     location, organizer, the "Zapisy do wydarzenia" button, description).
//     So two requests to sts-timing.pl cover the whole listing, and nothing
//     reads the 400 single-event pages.
//   - robots.txt disallows only /tmp/, /private/, /admin/, but declares
//     `Crawl-delay: 2000`. Two requests a day to sts-timing.pl honour it.
//     zapisy.sts-timing.pl has no robots.txt (404).
//
// registration_url — the card's "Zapisy do wydarzenia" button (EventON's
// evcal_lmlink), the link the source's own calendar shows a runner. It points
// at zapisy.sts-timing.pl/<id>/ for most races and at the organizer's own
// system for some. Measured 2026-11-07, those foreign links are not all good:
// a login page (rejestracja.maratonwarszawski.com/pl/login), a startlist.pl
// URL that answers 500 and names a different race, a Gdynia series form that
// names a 2025 series. So every button is fetched, redirects followed, and kept
// only when it answers 2xx, is not a login page, and the page carries a word of
// the race name (verifyRegistration). Otherwise the field stays empty.
//
// The zapisy.sts-timing.pl/<id>/ page is also where the distances, the fees and
// the regulamin are: <select id="distance"> lists one <option data-fee="130">
// per race ("5 KM - 130 zł", "dystans ok. 29 km - Start w Suszu - 0 zł"), and
// the header links "Regulamin / Rules". Verified on 1164 (Dycha Ciężkiego):
// the regulamin link adm/pdf/<hash>.pdf resolves against /1164/ to a 200
// application/pdf whose first line is "Regulamin Dychy Ciężkiego". The same
// page links a guardian consent form ("Oświadczenie opiekuna.pdf") on 1102,
// which the shared picker refuses.
//
// Every field comes from a fresh fetch on every run, so all upcoming events
// are emitted each time and re-emitting a known one cannot null anything.
// knownIds is accepted and ignored.

const BASE_URL = 'https://sts-timing.pl'
const ZAPISY_HOST = 'zapisy.sts-timing.pl'
const USER_AGENT = 'leszy.run/1.0 (lukasz@leszy.run)'
const DETAIL_DELAY_MS = 1100
const RANGE_DAYS = 730

const NB = '[^a-ząćęłńóśźż]'

// EventON event_type slugs on sts-timing.pl (2026-11-07). A race filed under a
// running type is kept; one filed under a non-running type is dropped even
// when it also carries a running one (a triathlon relay tagged "sztafety").
// Untyped events and "inne" / "sztafety" alone fall through to the name check.
const RUNNING_TYPES = new Set(['bieg', 'bieg-ocr', 'nordic-walking', 'ultra'])
const NON_RUNNING_TYPES = new Set([
  'aquabike', 'aquathlon', 'bieg-narciarski', 'bike', 'drifty-samochdowe', 'duathlon',
  'gravel', 'narty', 'rolki', 'rowery-szosowe', 'skoki-narciarskie', 'triathlon', 'wyscig-mtb',
])
const NON_RUNNING_NAME = /rower|kolarsk|\bmtb\b|gravel|enduro|szosow|drift|p[lł]ywa|narciar|\bnarty\b|rolk|\bbike\b|aquabike/i

export function isRunningEvent({ name, types = [] }) {
  if (types.some(t => NON_RUNNING_TYPES.has(t))) return false
  if (looksMultisport({ name })) return false
  if (types.some(t => RUNNING_TYPES.has(t))) return true
  return !NON_RUNNING_NAME.test(name || '')
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
  ['trail', /g[oó]rsk|leśn|lesn|\btrail\b|cross(?:owy|owa|owe)?\b|przełaj|przelaj/],
  ['nordic walking', /nordic\s*walking|\bnw\b|marsz\s+z\s+kijami/],
  ['ocr', /\bocr\b/],
]

// Style from the umbrella name (adding-a-new-scraper 5b). A race option can
// add Nordic Walking only when the name carries no style of its own, so the
// row never holds two styles an umbrella-only aggregator row would not.
export function detectEventTypes(name, { types = [], options = [] } = {}) {
  const n = (name || '').toLowerCase()
  const tags = []
  for (const [tag, re] of STYLE_RULES) if (re.test(n)) tags.push(tag)
  if (tags.length === 0) {
    if (types.includes('bieg-ocr')) tags.push('ocr')
    else if (options.some(o => STYLE_RULES[1][1].test(o.toLowerCase()))) tags.push('nordic walking')
  }
  if (/\bultra\b/.test(n) || types.includes('ultra')) tags.push('ultra')
  if (/charytatywn/.test(n)) tags.push('charytatywny')
  return tags
}

function formatKm(value) {
  return `${Number(value.toFixed(4))} km`
}

// One distance per race option: "dystans ok. 29 km - Start w Suszu - 0 zł",
// "5 KM - 130 zł", "Bieg dzieci 400 m - 0 zł". Only a number followed by a
// unit counts, so a fee or a start time never becomes a race.
export function distanceFromLabel(label) {
  const m = (label || '').match(/(\d+(?:[.,]\d+)?)\s*(km|m)(?![a-ząćęłńóśźż])/i)
  if (!m) return null
  const value = parseFloat(m[1].replace(',', '.'))
  if (!Number.isFinite(value) || value <= 0) return null
  if (m[2].toLowerCase() === 'km') return formatKm(value)
  if (value < 100) return null
  return value >= 1000 ? formatKm(value / 1000) : `${value} m`
}

// The card description is the regulamin's opening paragraphs. Read for
// kilometres only: it also says "oznaczona co 500 metrów", "parking 300 m od
// startu", so metres there are not races. Used only when no registration page
// lists the races.
export function distancesFromDescription(text) {
  if (!text) return null
  const out = []
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*km(?![a-ząćęłńóśźż])/gi)) {
    const value = parseFloat(m[1].replace(',', '.'))
    if (Number.isFinite(value) && value > 0 && value <= 400) out.push(formatKm(value))
  }
  const unique = [...new Set(out)]
  return unique.length ? unique.join(', ') : null
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim()
}

function plain(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
}

const NAME_STOPWORDS = new Set([
  'bieg', 'biegi', 'biegu', 'biegow', 'biegowe', 'biegowy', 'biegowa', 'marsz', 'edycja',
  'memorial', 'zawody', 'oraz', 'roku', 'dzieci', 'nordic', 'walking', 'imienia',
])

export function nameTokens(name) {
  return [...new Set(
    plain(name).split(/[^a-z0-9]+/)
      .filter(t => t.length >= 4 && !NAME_STOPWORDS.has(t) && !/^\d+$/.test(t)),
  )]
}

// The registration page is right for this race when it names it: at least
// half of the distinctive words of the race name (whole words, diacritics
// folded) must appear in the page text. One word was not enough: Gdynia's
// series form says "Gdyńskie Centrum Sportu", and "gdynski" is inside it.
// Measured 2026-11-07, every STS registration page and the two organizer
// pages that are right pass, and the Gdynia series form does not.
export function pageNamesEvent(html, name) {
  const tokens = nameTokens(name)
  if (tokens.length === 0) return false
  const $ = cheerio.load(html || '')
  $('script, style').remove()
  // Tags become spaces: .text() would glue "Ciężkiego</h2><a>Lista" into one word.
  const text = cheerio.load(($.html() || '').replace(/<[^>]+>/g, ' ')).text()
  const words = new Set(plain(text).split(/[^a-z0-9]+/))
  const found = tokens.filter(t => words.has(t)).length
  return found >= Math.ceil(tokens.length / 2)
}

// Tracking parameters copied in from a Facebook share (fbclid, utm_*) are not
// part of the address.
export function stripTracking(href) {
  try {
    const u = new URL(href)
    for (const k of [...u.searchParams.keys()]) {
      if (/^(fbclid|gclid|utm_[a-z]+|mc_[a-z]+)$/i.test(k)) u.searchParams.delete(k)
    }
    return u.toString()
  } catch {
    return null
  }
}

// zapisy.sts-timing.pl/<id> (with or without a trailing path) → its base URL.
export function zapisyBase(href) {
  try {
    const u = new URL(href)
    if (u.hostname !== ZAPISY_HOST) return null
    const id = u.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1]
    return id ? `https://${ZAPISY_HOST}/${id}/` : null
  } catch {
    return null
  }
}

export function parseNonce(html) {
  return (html || '').match(/evo_general_params\s*=\s*\{[^}]*?"n":"([0-9a-f]+)"/)?.[1] || null
}

// "2026-11-11T11:11+1:00", "2026-12-6T09:00+1:00" → "2026-12-06". The wall
// date is the organizer's Warsaw date; no time zone arithmetic.
export function isoDate(startDate) {
  const m = (startDate || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (!m) return null
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

// The HTML half of the AJAX answer: one div#event_<id>_<repeat> per card.
export function parseCards(html) {
  const $ = cheerio.load(html || '')
  const cards = []
  $('div.eventon_list_event[data-event_id]').each((_, el) => {
    const card = $(el)
    const id = card.attr('data-event_id')
    const date = isoDate(card.find('meta[itemprop="startDate"]').first().attr('content'))
    const name = clean(card.find('.evcal_event_title').first().text())
    if (!id || !date || !name) return
    const permalink = card.find('.evo_event_schema a[itemprop="url"]').first().attr('href') || null
    const location = clean(card.find('.evo_location_name').first().text())
      || clean(card.find('.evcal_event_subtitle').first().text()) || null
    const lmlink = card.find('.evo_metarow_learnM a[href]').first().attr('href') || null
    let organizerLink = card.find('.evo_card_organizer_name_t a[href^="http"]').first().attr('href') || null
    // An organizer link that is a contact page belongs to the organizer, not
    // this race (the Warsaw run links polmaratonwarszawski.com/kontakt/).
    if (organizerLink && (/sts-timing\.pl/i.test(organizerLink) || /kontakt|contact/i.test(organizerLink))) organizerLink = null
    const descEl = card.find('.eventon_full_description').first()
    const descClone = descEl.clone()
    descClone.find('br').replaceWith(' ')
    const description = clean(descClone.text())
    cards.push({
      id, date, name, location,
      permalink: permalink || null,
      lmlink: lmlink ? stripTracking(lmlink) : null,
      website: organizerLink,
      description,
    })
  })
  // A repeating event prints one card per occurrence; the first is kept.
  const seen = new Set()
  return cards.filter(c => (seen.has(c.id) ? false : (seen.add(c.id), true)))
}

// "…/1102/Regulamin Biegiem Pomagam 2026.pdf" is linked with raw spaces.
function encodeUrl(href) {
  if (!href) return null
  try { return new URL(href).href } catch { return null }
}

// The zapisy.sts-timing.pl/<id>/ registration page.
export function parseZapisy(html, baseUrl) {
  const $ = cheerio.load(html || '')
  const options = []
  $('select#distance option[data-fee]').each((_, o) => {
    const label = clean($(o).text())
    const fee = parseFloat(($(o).attr('data-fee') || '').replace(',', '.'))
    options.push({ label, fee: Number.isFinite(fee) ? fee : null })
  })
  const distances = [...new Set(options.map(o => distanceFromLabel(o.label)).filter(Boolean))]
  // A fee counts only when the option prints it ("... - 0 zł"), so a free
  // charity race is 0 and a missing attribute is nothing.
  const fees = options.filter(o => o.fee !== null && /\d\s*zł/i.test(o.label)).map(o => o.fee)
  return {
    options: options.map(o => o.label),
    distances: distances.length ? distances.join(', ') : null,
    priceFrom: fees.length ? Math.min(...fees) : null,
    priceTo: fees.length ? Math.max(...fees) : null,
    regulaminUrl: encodeUrl(pickRegulaminFromDom($, { selector: 'a[href]', baseUrl })),
  }
}

export function buildRow(card, { types = [], zapisy = null, registrationUrl = null } = {}) {
  const options = zapisy?.options || []
  return {
    name: card.name,
    date: card.date,
    location: card.location,
    distances: zapisy?.distances || distancesFromDescription(card.description),
    registration_url: registrationUrl,
    registration_deadline: null,
    regulamin_url: zapisy?.regulaminUrl || null,
    website: card.website,
    is_kids: hasKidsSignal(card.name) || options.some(hasKidsSignal),
    event_types: detectEventTypes(card.name, { types, options }),
    price_from: zapisy?.priceFrom ?? null,
    price_to: zapisy?.priceTo ?? null,
    source: 'ststiming',
    source_id: String(card.id),
    source_url: card.permalink || `${BASE_URL}/?p=${card.id}`,
  }
}

async function fetchText(url, init = {}) {
  const res = await fetch(url, { redirect: 'follow', ...init, headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return { text: await res.text(), url: res.url || url }
}

// A registration link is kept only when it answers, is not a login wall and
// names the race (see the header).
async function verifyRegistration(url, name) {
  try {
    const { text, url: finalUrl } = await fetchText(url)
    if (/\/(login|logowanie|signin)\b/i.test(new URL(finalUrl).pathname)) return { ok: false, html: text }
    return { ok: pageNamesEvent(text, name), html: text }
  } catch (err) {
    return { ok: false, html: null, error: err.message }
  }
}

async function fetchCalendar(now = new Date()) {
  const { text: page } = await fetchText(`${BASE_URL}/wydarzenia/`)
  const nonce = parseNonce(page)
  if (!nonce) throw new Error('EventON nonce not found on /wydarzenia/')
  const start = Math.floor(now.getTime() / 1000) - 86400
  const body = new URLSearchParams({
    'shortcode[focus_start_date_range]': String(start),
    'shortcode[focus_end_date_range]': String(start + RANGE_DAYS * 86400),
    'shortcode[number_of_months]': '24',
    'shortcode[event_past_future]': 'future',
    'shortcode[hide_past]': 'yes',
    'shortcode[event_type]': 'all',
    'shortcode[sort_by]': 'sort_date',
    direction: 'none',
    nonce,
  })
  const { text } = await fetchText(`${BASE_URL}/?evo-ajax=eventon_get_events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = JSON.parse(text)
  if (data.status !== 'GOOD') throw new Error(`EventON answered ${data.status}: ${data.msg || ''}`)
  return data
}

async function fetchTypes(ids) {
  const types = new Map()
  if (ids.length === 0) return types
  const { text: termsJson } = await fetchText(`${BASE_URL}/wp-json/wp/v2/event_type?per_page=100&_fields=id,slug`)
  const slugById = new Map(JSON.parse(termsJson).map(t => [t.id, t.slug]))
  const { text: eventsJson } = await fetchText(
    `${BASE_URL}/wp-json/wp/v2/ajde_events?include=${ids.join(',')}&per_page=100&_fields=id,event_type`,
  )
  for (const e of JSON.parse(eventsJson)) {
    types.set(String(e.id), (e.event_type || []).map(id => slugById.get(id)).filter(Boolean))
  }
  return types
}

function warsawToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(now)
}

async function scrape() {
  const results = []
  try {
    const data = await fetchCalendar()
    const today = warsawToday()
    const cards = parseCards(data.html).filter(c => c.date >= today)
    const types = await fetchTypes(cards.map(c => c.id))
    const running = cards.filter(c => isRunningEvent({ name: c.name, types: types.get(c.id) || [] }))
    console.log(`[ststiming] Found ${cards.length} upcoming events, ${running.length} running`)

    for (const card of running) {
      const eventTypes = types.get(card.id) || []
      let zapisy = null
      let registrationUrl = null
      if (card.lmlink) {
        const check = await verifyRegistration(card.lmlink, card.name)
        if (check.ok) registrationUrl = card.lmlink
        else console.log(`[ststiming] ${card.id}: registration link not verified, left empty (${card.lmlink}${check.error ? `: ${check.error}` : ''})`)
        const base = zapisyBase(card.lmlink)
        if (base && check.error) {
          // An STS registration page that did not answer this time: emitting
          // the row would null its stored distances, fees and regulamin.
          console.log(`[ststiming] ${card.id}: skipped, the next run reads it again`)
          await new Promise(r => setTimeout(r, DETAIL_DELAY_MS))
          continue
        }
        if (base && check.ok) {
          // The button may point at a sub-page (/1160/zapisy/); the race list
          // and the regulamin are on the event's base page.
          try {
            const html = base === card.lmlink ? check.html : (await fetchText(base)).text
            zapisy = parseZapisy(html, base)
          } catch (err) {
            console.log(`[ststiming] ${card.id}: registration page unreadable (${err.message}), skipped`)
            await new Promise(r => setTimeout(r, DETAIL_DELAY_MS))
            continue
          }
        }
        await new Promise(r => setTimeout(r, DETAIL_DELAY_MS))
      }
      results.push(buildRow(card, { types: eventTypes, zapisy, registrationUrl }))
    }
    console.log(`[ststiming] Scraped ${results.length} events`)
  } catch (err) {
    console.error('[ststiming] Scrape failed:', err.message)
  }
  return results
}

export { scrape }
