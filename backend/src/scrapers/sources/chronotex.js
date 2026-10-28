import * as cheerio from 'cheerio'
import { pickRegulaminFromDom } from '../../lib/pickRegulaminUrl.js'

// chronotex.pl — Chronotex timing company (Skierniewice), races across Łódzkie,
// Śląskie, Małopolska, Podkarpacie, Mazowsze and Lubelskie. It hosts its own
// registration, so it is the only listing for races whose organizers publish
// nowhere else. 8 Knurowski Bieg Niepodległości (2026-11-11) reached us only
// through maratonypolskie before this scraper existed.
//
// Two pages, both server-rendered custom PHP inside WordPress (no wp-json route
// for the events, no iCal):
//   /zawody/                              one table: date | name | town, every
//                                         row links to the detail page
//   /opis-zawodow/?id_zawodow=<id>        label/value table (td.b-par / td.b-war):
//                                         "Miejsce i termin", "Opis zawodów",
//                                         "Wpisowe i wpłata", "Regulamin zawodów",
//                                         "Strona WWW"
//
// The detail page also prints the list of registered participants. Nothing from
// it is read.
//
// registration_url — the "Zarejestruj się" button under the table links
// /rejestracja/?id_zawodow=<id>. Verified 2026-10-28 with curl -sIL on 1398
// (Bieg Obrońców Modlina): 200 with no redirect, a <form id="rejestracja"> and
// the race name on the page. No login, so the id cannot be lost. Once
// registration closes the button is gone and the page says "Rejestracja
// zamknięta"; the detail page is then the registration url, as on foxter and
// zapisyonline, because that is where the source sends a runner.
//
// The listing is 15 rows, so every row's detail page is re-read on every run.
// Registration opens and closes, fees step up, and with every field coming from
// a fresh fetch, re-emitting a known row cannot null anything.

const BASE_URL = 'https://chronotex.pl'
const USER_AGENT = 'leszy.run/1.0 (kontakt@leszy.run)'

const NB = '[^a-ząćęłńóśźż]'

export function hasKidsSignal(text) {
  if (!text) return false
  const s = ` ${text.toLowerCase()} `
  if (/(?:biegi|bieg|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  return false
}

// Style from the umbrella name only (adding-a-new-scraper 5b): the description
// mentions a Nordic Walking march on most of these races, and tagging that would
// keep them from merging with aggregator rows tagged from the name.
export function detectEventTypes(name) {
  const n = (name || '').toLowerCase()
  const tags = []
  if (/g[oó]rsk|leśn|lesn|\btrail\b|cross(?:owy|owa|owe)?\b|przełaj|przelaj/.test(n)) tags.push('trail')
  if (/nordic\s*walking|\bnw\b|marsz\s+z\s+kijami/.test(n)) tags.push('nordic walking')
  if (/charytatywn/.test(n)) tags.push('charytatywny')
  return tags
}

// "Bieg na dystansie 21,0975km", "bieg 10 km oraz marsz Nordic Walking 5 km",
// "Bieg OPEN na dystansie 5000 m". Only a number followed by a unit counts, so
// a street number or a birth year never becomes a race.
export function parseDistances(text) {
  if (!text) return null
  const out = []
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*(km|m)(?![a-ząćęłńóśźż])/gi)) {
    let value = parseFloat(m[1].replace(',', '.'))
    const unit = m[2].toLowerCase()
    if (!Number.isFinite(value) || value <= 0) continue
    if (unit === 'm') {
      if (value < 100) continue
      if (value >= 1000) value = value / 1000
      else { out.push(`${value} m`); continue }
    }
    out.push(`${value} km`)
  }
  const unique = [...new Set(out)]
  return unique.length ? unique.join(', ') : null
}

// The "Wpisowe i wpłata" cell is the fee section and holds nothing but fees
// and dates: "- 65 zł pierwsze 100 osób / - 80 zł w biurze zawodów".
// Day-of fees count, since the range is what a runner may pay.
export function parseFees(text) {
  if (!text) return { priceFrom: null, priceTo: null }
  const amounts = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*zł/gi)]
    .map(m => parseFloat(m[1].replace(',', '.')))
    .filter(Number.isFinite)
  if (amounts.length === 0) return { priceFrom: null, priceTo: null }
  return { priceFrom: Math.min(...amounts), priceTo: Math.max(...amounts) }
}

// "Zapisy i płatności przez stronę do 3.11.2026" — the first date after "do" in
// the fee cell is the online deadline; later ones are price-tier steps or the
// race office.
export function parseDeadline(text) {
  if (!text) return null
  const m = text.match(/\bdo\s+(?:dnia\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})/i)
  if (!m) return null
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

export function parseListing(html) {
  const $ = cheerio.load(html)
  const entries = []
  $('tr').each((_, tr) => {
    const cells = $(tr).find('td')
    if (cells.length < 3) return
    const date = $(cells[0]).text().replace(/ /g, ' ').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return
    const link = $(cells[1]).find('a[href*="id_zawodow="]').first()
    const id = (link.attr('href') || '').match(/id_zawodow=(\d+)/)?.[1]
    if (!id) return
    // The name cell is the race name in <b>, sometimes followed by a subtitle
    // after a <br> ("SKIERNIEWICKA TRIADA BIEGOWA", a patronage line). The
    // first line is the race. A kids subtitle stays: 1405 is "BIEG OBROŃCÓW
    // MODLINA" + "BIEGI MŁODZIEŻOWE", the youth races of 1398, which has the
    // same first line, date and town and would otherwise merge into it.
    const nameHtml = $(cells[1]).find('b').first().html() || $(cells[1]).html() || ''
    const lines = nameHtml.split(/<br\s*\/?>/i)
      .map(l => cheerio.load(l).text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    const kidsSubtitle = lines.slice(1).find(hasKidsSignal)
    const name = kidsSubtitle ? `${lines[0]} - ${kidsSubtitle}` : (lines[0] || '')
    const location = $(cells[2]).text().replace(/ /g, ' ').trim() || null
    if (!name) return
    entries.push({ id, date, name, location })
  })
  return entries
}

function labelledCells($) {
  const cells = new Map()
  $('td.b-par').each((_, el) => {
    const label = $(el).text().replace(/:\s*$/, '').trim().toLowerCase()
    const value = $(el).next('td.b-war')
    if (label && value.length && !cells.has(label)) cells.set(label, value)
  })
  return cells
}

function cellText($, cell) {
  if (!cell) return ''
  const clone = cell.clone()
  clone.find('br').replaceWith(' / ')
  return clone.text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
}

export function parseDetail(html, id) {
  const $ = cheerio.load(html)
  const cells = labelledCells($)
  const detailUrl = `${BASE_URL}/opis-zawodow/?id_zawodow=${id}`

  const opis = cellText($, cells.get('opis zawodów'))
  const fees = cellText($, cells.get('wpisowe i wpłata'))

  // The link sits in its own "Regulamin zawodów" row, so the row is the
  // evidence; the link text is just "PDF" and the filename a timestamp
  // (../upload/1790155084.pdf). A second row like "Regulamin GRAND PRIX
  // Knurowa" is a series document and is never read.
  const regulaminCell = cells.get('regulamin zawodów')
  const regulaminUrl = regulaminCell
    ? pickRegulaminFromDom($, { root: regulaminCell, selector: 'a[href]', baseUrl: `${BASE_URL}/opis-zawodow/`, requireToken: false })
    : null

  const websiteCell = cells.get('strona www')
  const website = websiteCell?.find('a[href^="http"]').first().attr('href') || null

  const registerHref = $(`a[href*="/rejestracja/?id_zawodow=${id}"]`).first().attr('href')
  const registrationUrl = registerHref ? new URL(registerHref, BASE_URL).href : detailUrl

  const { priceFrom, priceTo } = parseFees(fees)
  return {
    opis,
    distances: parseDistances(opis),
    regulaminUrl,
    website,
    registrationUrl,
    priceFrom,
    priceTo,
    deadline: parseDeadline(fees),
  }
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

export function buildRow(entry, detail) {
  const detailUrl = `${BASE_URL}/opis-zawodow/?id_zawodow=${entry.id}`
  return {
    name: entry.name,
    date: entry.date,
    location: entry.location,
    distances: detail.distances,
    registration_url: detail.registrationUrl,
    registration_deadline: detail.deadline,
    regulamin_url: detail.regulaminUrl,
    website: detail.website,
    is_kids: hasKidsSignal(`${entry.name} ${detail.opis}`),
    event_types: detectEventTypes(entry.name),
    price_from: detail.priceFrom,
    price_to: detail.priceTo,
    source: 'chronotex',
    source_id: entry.id,
    source_url: detailUrl,
  }
}

async function scrape() {
  const results = []
  try {
    const entries = parseListing(await fetchText(`${BASE_URL}/zawody/`))
    const today = new Date().toISOString().slice(0, 10)
    const future = entries.filter(e => e.date >= today)
    console.log(`[chronotex] Found ${entries.length} events, ${future.length} upcoming`)

    for (const entry of future) {
      try {
        const html = await fetchText(`${BASE_URL}/opis-zawodow/?id_zawodow=${entry.id}`)
        results.push(buildRow(entry, parseDetail(html, entry.id)))
      } catch (err) {
        // A row emitted without its detail page would overwrite the stored
        // regulamin and registration url with nulls. Skip it; the next run
        // reads it again.
        console.log(`[chronotex] ${entry.id}: detail page unreadable (${err.message}), skipped`)
      }
      await new Promise(r => setTimeout(r, 1100))
    }
    console.log(`[chronotex] Scraped ${results.length} events with details`)
  } catch (err) {
    console.error('[chronotex] Scrape failed:', err.message)
  }
  return results
}

export { scrape }
