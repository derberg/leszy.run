import * as cheerio from 'cheerio'
import { pickRegulaminFromDom } from '../../lib/pickRegulaminUrl.js'

// catchtime.pl — CatchTime, a timing company from northern Mazowsze (Przasnysz,
// Maków Mazowiecki, Jednorożec, Płońsk, Różan). About 25 races a year, most of
// them small local runs that no platform we scrape lists.
//
// WordPress + Elementor. Investigated 2026-11-08:
//   - The REST API exposes no event post type: every race is an ordinary
//     Elementor page, so /wp-json/ gives nothing structured.
//   - /zawody-aktualne/ is the season's race list, one Elementor section per
//     race: the date, the name (a second line after <br> is an edition, a
//     series or a second race), a countdown, the town. The section itself is
//     the link, through Happy Addons' data-ha-element-link JSON. A column inside
//     the section can carry its own link to an older page (the town of
//     "GRUDUSK NA 5-TKĘ" pointed at the 2024 Mikołajkowy page), so only the
//     section's link is read.
//   - The listing date is the authority. The page slug usually ends in DDMMYYYY
//     but is not maintained: wieczorna-piatka-13062026 is the 20.06.2026 race,
//     strefa-04102926 has a typo, and the countdown's "until" is sometimes a
//     copy from the previous section.
//   - Every "ZAKOŃCZONO" on the listing is the countdown widget's hidden expiry
//     message, printed for every race; it says nothing about the race.
//   - robots.txt disallows only /wp-admin/.
//
// The race page is free text in fixed headed blocks (ORGANIZATOR, OPIS
// ZAWODÓW, HARMONOGRAM, WPISOWE, WARUNKI UCZESTNICTWA, REGULAMIN), followed by
// Elementor buttons: "REGULAMIN" (a PDF under wp-content/uploads), "ZAPISZ SIĘ
// …" (one per registration form) and "OPŁACENI" (the paid list).
//
// registration_url — the first "ZAPISZ SIĘ" button, the source's own sign-up
// link. It points at a catchtime.pl page holding a Fluent Forms form for that
// race (zap5km-bieg-niepodleglosci-11112026/ → "Zapisy na 5 km: BIEG
// NIEPODLEGŁOŚCI 11.11.2026 Płońsk"). Verified 2026-11-08 with curl -sIL on all
// three upcoming races: 200 with no redirect, each page naming its race. When
// there are two buttons (main race, kids races) the first is the main race.
// A finished race loses its buttons, so the field is then empty.
//
// regulamin_url — the shared picker over the page's PDF links. The file name
// often carries no token (V-Bieg-Niepodleglosci-2026.pdf), the button label
// "REGULAMIN" does; the results PDFs (Wyniki-…) are refused by the deny-list.
//
// Every field comes from a fresh fetch of the race page on every run, so all
// upcoming races are emitted each time and re-emitting a known one cannot null
// anything; a race page that does not answer is skipped. knownIds is accepted
// and ignored.

const BASE_URL = 'https://catchtime.pl'
const LIST_URL = `${BASE_URL}/zawody-aktualne/`
const USER_AGENT = 'leszy.run/1.0 (lukasz@leszy.run)'
const DETAIL_DELAY_MS = 1100

const NB = '[^a-ząćęłńóśźż]'

const NON_RUNNING_NAME = /rowe|kolarsk|\bmtb\b|gravel|p[lł]ywa|narciar|\bnarty\b|rolk|triathlon|duathlon/i

export function isRunningEvent(name) {
  return !NON_RUNNING_NAME.test(name || '')
}

export function hasKidsSignal(text) {
  if (!text) return false
  const s = ` ${text.toLowerCase()} `
  if (/(?:biegi|bieg|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci`).test(s)) return true
  if (new RegExp(`${NB}przedszkol`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}brzd[aą]c`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

const STYLE_RULES = [
  // leśn only at the start of a word: Oleśnica and Oleśno are towns (see ststiming, #433).
  ['trail', /g[oó]rsk|(?:^|[^a-ząćęłńóśźż])le[sś]n|\btrail\b|cross(?:owy|owa|owe)?\b|przełaj|przelaj|przałaj/],
  ['nordic walking', /nordic\s*walking|\bnw\b|marsz\s+z\s+kijami/],
  ['ocr', /\bocr\b/],
]

// Style from the race name (adding-a-new-scraper 5b). The race page may add
// Nordic Walking only when the name carries no style of its own, so the row
// never holds two styles an umbrella-only aggregator row would not.
export function detectEventTypes(name, pageText = '') {
  const n = (name || '').toLowerCase()
  const tags = []
  for (const [tag, re] of STYLE_RULES) if (re.test(n)) tags.push(tag)
  if (tags.length === 0 && /nordic\s*walking|marsz\s+z\s+kijami/i.test(pageText || '')) tags.push('nordic walking')
  if (/\bultra\b/.test(n)) tags.push('ultra')
  if (/charytatywn/.test(n)) tags.push('charytatywny')
  return tags
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim()
}

// Text of an element with every <br> as a line break.
function lines($, el) {
  const c = $(el).clone()
  c.find('br').replaceWith('\n')
  return c.text().split('\n').map(clean).filter(Boolean)
}

// "11.11.2026" → "2026-11-11"; "15-16.09.2026" → the first day.
// "lipiec 2026" (no day) → null, and the race is dropped.
export function parseListingDate(text) {
  const m = clean(text).match(/^(\d{1,2})(?:\s*-\s*\d{1,2})?\.(\d{1,2})\.(\d{4})$/)
  if (!m) return null
  const [, d, mo, y] = m
  const day = Number(d)
  const month = Number(mo)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// A second name line that is only a distance ("WIECZORNA PIĄTKA<br>5000 m")
// is dropped from the name; the race page lists the distances.
export function buildName(nameLines) {
  const kept = nameLines.filter((l, i) => i === 0 || !/^\d+(?:[.,]\d+)?\s*(?:km|m)$/i.test(l))
  return clean(kept.join(' '))
}

// "Przasnysz<br>(lotnisko)" → "Przasnysz", "Maków<br>Mazowiecki" → "Maków Mazowiecki".
export function buildLocation(townLines) {
  const s = clean(townLines.join(' ').replace(/\([^)]*\)/g, ' '))
  return s || null
}

export function slugFromUrl(url) {
  try {
    const u = new URL(url, BASE_URL)
    if (u.hostname !== 'catchtime.pl') return null
    const slug = u.pathname.split('/').filter(Boolean).pop()
    return slug || null
  } catch {
    return null
  }
}

export function parseListing(html) {
  const $ = cheerio.load(html || '')
  const races = []
  const seen = new Set()
  $('section.elementor-top-section[data-ha-element-link]').each((_, sec) => {
    let url = null
    try { url = JSON.parse($(sec).attr('data-ha-element-link') || '{}').url || null } catch { url = null }
    const slug = url ? slugFromUrl(url) : null
    if (!slug || seen.has(slug)) return
    const headings = $(sec).find('h2.elementor-heading-title').toArray().map(h => lines($, h))
    if (headings.length < 2) return
    const date = parseListingDate(headings[0].join(' '))
    const name = buildName(headings[1])
    if (!date || !name) return
    seen.add(slug)
    races.push({
      slug,
      url: `${BASE_URL}/${slug}/`,
      date,
      name,
      location: headings.length >= 3 ? buildLocation(headings[headings.length - 1]) : null,
    })
  })
  return races
}

function formatKm(value) {
  return `${Number(value.toFixed(4))} km`
}

// Distances written in the description and the schedule: "dystans 100m",
// "na 5 km", "– 15 km", "4,2 km". Only a number followed by a unit counts, so a
// start time or a fee never becomes a race; metres under 50 are not races.
export function distancesFromText(text) {
  if (!text) return null
  const out = []
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*(km|m)(?![a-ząćęłńóśźż])/gi)) {
    const value = parseFloat(m[1].replace(',', '.'))
    if (!Number.isFinite(value) || value <= 0) continue
    if (m[2].toLowerCase() === 'km') {
      if (value <= 400) out.push(formatKm(value))
    } else if (value >= 1000) {
      out.push(formatKm(value / 1000))
    } else if (value >= 50) {
      out.push(`${value} m`)
    }
  }
  const unique = [...new Set(out)]
  return unique.length ? unique.join(', ') : null
}

// Fees from the WPISOWE block only: "40 zł – opłata online …", "60zł. w biurze".
// The bank account number in the same block is not followed by "zł".
export function pricesFromFees(text) {
  if (!text) return { priceFrom: null, priceTo: null }
  const fees = []
  for (const m of text.matchAll(/(\d{1,4})(?:,00)?\s*zł/gi)) {
    const v = Number(m[1])
    if (Number.isFinite(v)) fees.push(v)
  }
  if (fees.length === 0) return { priceFrom: null, priceTo: null }
  return { priceFrom: Math.min(...fees), priceTo: Math.max(...fees) }
}

const BLOCK_HEADINGS = /^(ORGANIZATOR|ORGANIZATORZY|PARTNERZY|PATRONAT|PATRONI|OPIS ZAWODÓW|HARMONOGRAM ZAWODÓW:?|WPISOWE|NAGRODY|WARUNKI UCZESTNICTWA|REGULAMIN|DO ZAWODÓW ZOSTAŁO:?|WYNIKI:?|KONTAKT:?)$/i

export function parseDetail(html, pageUrl) {
  const $ = cheerio.load(html || '')
  $('script, style, header, footer, nav').remove()
  const root = $('main').length ? $('main') : $('body')
  // One line per text block, in page order, so the headed blocks can be cut.
  const all = []
  root.find('h1, h2, h3, h4, h5, h6, p, li, span.elementor-button-text').each((_, el) => {
    if ($(el).find('p, li, h1, h2, h3, h4, h5, h6').length) return
    for (const l of lines($, el)) all.push(l)
  })
  const idx = (re) => all.findIndex(l => re.test(l))
  const feesAt = idx(/^WPISOWE$/i)
  const endAt = (from) => {
    const rel = all.slice(from + 1).findIndex(l => BLOCK_HEADINGS.test(l) || /^ZAPISZ/i.test(l))
    return rel === -1 ? all.length : from + 1 + rel
  }
  // The race description: everything before the fees (or before the buttons).
  let descEnd = feesAt
  if (descEnd === -1) descEnd = idx(/^(REGULAMIN|ZAPISZ|DO ZAWODÓW ZOSTAŁO)/i)
  if (descEnd === -1) descEnd = all.length
  const description = all.slice(0, descEnd).join('\n')
  const fees = feesAt === -1 ? '' : all.slice(feesAt + 1, endAt(feesAt)).join('\n')

  let registrationUrl = null
  const buttonLabels = []
  root.find('a[href]').each((_, a) => {
    const label = clean($(a).text())
    if (!/zapisz\s+si/i.test(label)) return
    buttonLabels.push(label)
    if (registrationUrl) return
    try {
      const u = new URL($(a).attr('href'), pageUrl)
      if (u.hostname === 'catchtime.pl') registrationUrl = u.toString()
    } catch { /* not a URL */ }
  })

  const { priceFrom, priceTo } = pricesFromFees(fees)
  return {
    description,
    buttonLabels,
    distances: distancesFromText(description),
    priceFrom,
    priceTo,
    registrationUrl,
    regulaminUrl: pickRegulaminFromDom($, { selector: 'a[href$=".pdf"]', baseUrl: pageUrl }),
  }
}

export function buildRow(race, detail) {
  return {
    name: race.name,
    date: race.date,
    location: race.location,
    distances: detail.distances,
    registration_url: detail.registrationUrl,
    registration_deadline: null,
    regulamin_url: detail.regulaminUrl,
    website: null,
    is_kids: hasKidsSignal(race.name) || hasKidsSignal(detail.description) || detail.buttonLabels.some(hasKidsSignal),
    event_types: detectEventTypes(race.name, detail.description),
    price_from: detail.priceFrom,
    price_to: detail.priceTo,
    source: 'catchtime',
    source_id: race.slug,
    source_url: race.url,
  }
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

function warsawToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(now)
}

async function scrape() {
  const results = []
  try {
    const today = warsawToday()
    const all = parseListing(await fetchText(LIST_URL))
    const upcoming = all.filter(r => r.date >= today && isRunningEvent(r.name))
    console.log(`[catchtime] Found ${all.length} races, ${upcoming.length} upcoming running`)
    for (const race of upcoming) {
      await new Promise(r => setTimeout(r, DETAIL_DELAY_MS))
      try {
        const detail = parseDetail(await fetchText(race.url), race.url)
        results.push(buildRow(race, detail))
      } catch (err) {
        console.log(`[catchtime] ${race.slug}: race page unreadable (${err.message}), skipped`)
      }
    }
    console.log(`[catchtime] Scraped ${results.length} events`)
  } catch (err) {
    console.error('[catchtime] Scrape failed:', err.message)
  }
  return results
}

export { scrape }
