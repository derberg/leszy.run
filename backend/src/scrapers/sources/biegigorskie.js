// biegigorskie.pl is the Polish mountain-running calendar. Nationwide in reach but
// single-discipline: everything on it is a bieg górski, so it covers precisely the
// regions our platform scrapers reach worst (Beskidy, Bieszczady, Karkonosze, Tatry,
// Sudety, Jura). Measured 2026-09-17: of its 40 future rows, 5 were absent from
// calendar_events.
//
// It is an editorial portal, not a registration host, which is the point. Its ZAPISY
// links lead to the organizer's own sign-up page, including b4sport organizer
// subsites that b4sport's own opt-in calendar never lists.
//
// Data source: one page per year at /kalendarz-<YEAR>/, a WordPress Supsystic table
// rendered fully server-side. No JS, no detail-page fetches, no pagination. 171 rows
// for 2026. robots.txt disallows only /wp-admin/.
//
// The markup is a spreadsheet export, so cells are addressed by `data-x` column index
// rather than document order, and every cell may hold several <br>-separated values:
//
//   x=0  race-type icons        cross / anglosaski / alpejski / dlugi / ultra / rajd …
//   x=1  date                   "03 października 2026", "02-04 października 2026"
//   x=2  place                  city <br> mountain range <br> country
//   x=3  distances              "10km" <br> "(+650m)" <br> "~500mUp" <br> "Vertical"
//   x=4  name + organizer site  umbrella name <br> sub-race names, linked to its own domain
//   x=5  PZBG category          Kat.I / Kat.II / Kat.S / Kat.M / x
//   x=6  social                 Facebook link
//   x=7  ZAPISY or WYNIKI       sign-up link, or results once the edition is run
//
// STYLE TAGS COME FROM THE ICONS, not from the name. The icons are the portal's own
// classification and are present on every row, whereas most mountain-race names carry
// no style word at all. The running-style icons give `trail`, and `ULICZNY-1.png`
// marks the rare road race and gives none.
//
// The `ultra-2.png` icon is deliberately NOT turned into an `ultra` tag. Every race
// here is a mountain race, so `trail` already says what the row is, and the extra tag
// mostly costs us merges: the merge guard compares the style tags of two rows as a
// set, so a row we tag `{trail, ultra}` will not join a generalist source's `{trail}`
// for the same race. Nordic walking stays, because it is a real second style that
// this source sometimes carries and others miss.
//
// NON-RUNNING: the same table carries a few cycling and run-kayak events. They are
// dropped by icon (`kolarz.jpg`, `runkajak.jpg`), which is more reliable than a name
// keyword because these names say nothing about the discipline.
//
// Only future rows are emitted. Past rows are frozen editions whose ZAPISY cell has
// already been replaced by WYNIKI, so they carry no registration link to offer.
//
// Listing portal, registration lives elsewhere → priority 8, next to motivato and
// biegnijmy. voivodeship left null → geocoded from city. prices/deadline → enricher.

import * as cheerio from 'cheerio'

const BASE = 'https://www.biegigorskie.pl'
const UA = 'leszy.run/1.0 (kontakt@leszy.run)'

const POLISH_MONTHS = {
  stycznia: '01', lutego: '02', marca: '03', kwietnia: '04',
  maja: '05', czerwca: '06', lipca: '07', sierpnia: '08',
  wrzesnia: '09', września: '09', pazdziernika: '10', października: '10',
  listopada: '11', grudnia: '12',
}

// Icon filenames, which are the portal's own discipline marks.
const TRAIL_ICONS = /^(cross|anglosaski|alpejski|dlugi|downhill|rajd|trekking|dogtrekking)/i
const ROAD_ICON = /^uliczny/i
const NON_RUNNING_ICONS = /^(kolarz|runkajak)/i

// JS \b doesn't recognize Polish letters, so use a manual non-letter boundary.
const NB = '[^a-ząćęłńóśźż]'

const slugify = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, c => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[c] || c))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/**
 * "03 października 2026" → 2026-10-03, and a range keeps its first day:
 * "02-04 października 2026" → 2026-10-02. A multi-day mountain race is one event
 * and the calendar sorts it under the day it starts.
 */
function parseDate(raw) {
  if (!raw) return null
  const m = raw.trim().replace(/\s+/g, ' ')
    .match(/^(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\s+([A-Za-zĄąĆćĘęŁłŃńÓóŚśŹźŻż]+)\s+(\d{4})$/)
  if (!m) return null
  const month = POLISH_MONTHS[m[2].toLowerCase()]
  if (!month) return null
  return `${m[3]}-${month}-${m[1].padStart(2, '0')}`
}

/**
 * Keep the distance tokens and drop everything the elevation column mixes in with
 * them. A token qualifies only if it is a bare number and a unit, so "12,5km" is a
 * distance while "(+650m)", "~500mUp", "(+/-940m)" and "Vertical" are not. Matching
 * a number followed by "m" anywhere would read "~500mUp" as a 500 m race.
 */
function cleanDistances(parts) {
  const out = []
  for (const raw of parts) {
    const m = (raw || '').trim().match(/^(\d+(?:[.,]\d+)?)\s*(km|m)$/i)
    if (!m) continue
    const value = m[1].replace(',', '.')
    const unit = m[2].toLowerCase()
    if (unit === 'm' && parseFloat(value) > 1000) continue // an elevation that slipped through
    const token = `${value} ${unit}`
    if (!out.includes(token)) out.push(token)
  }
  return out.length ? out.join(', ') : null
}

/**
 * Style tags. The icons decide trail; the text is read for the two styles the icon
 * set has no mark for. A road-marked row gets no trail tag, and no row gets `ultra`
 * (see the note at the top of the file).
 */
function detectEventTypes(icons, blob) {
  const tags = new Set()
  const road = icons.some(i => ROAD_ICON.test(i))
  if (!road && icons.some(i => TRAIL_ICONS.test(i))) tags.add('trail')
  const s = (blob || '').toLowerCase()
  if (/nordic\s*walking|\bnw\b|marsz\s+z\s+kijami/i.test(s)) tags.add('nordic walking')
  if (/\bocr\b/i.test(s)) tags.add('ocr')
  return [...tags]
}

function hasKidsSignal(name) {
  if (!name) return false
  const s = ` ${name.toLowerCase()} `
  if (/(?:biegi|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

const isOwnHost = href => /biegigorskie\.pl/i.test(href || '')

// Words that name a kind of event rather than an event. A first line built only
// from these is a heading, not a name.
const GENERIC_NAME_WORD = /^(?:rajd|rajdy|bieg|biegi|marsz|marsze|pieszy|piesze|pieszych|g[oó]rski|g[oó]rska|g[oó]rskie|zawody|festiwal)$/i

/**
 * Almost every name cell opens with the umbrella name, and later lines are its
 * sub-races. The exception is a row whose first line is a bare category, such as
 * `RAJD PIESZY` above `„Tam i z Powrotem"`, where the name is on the second line.
 * Recognised by the first line having no word of its own left once the category
 * words are removed.
 */
function isGenericHeading(s) {
  const words = (s || '').toLowerCase().replace(/[^a-ząćęłńóśźż0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  return words.length > 0 && words.every(w => GENERIC_NAME_WORD.test(w))
}

/** Split a cell into its <br>-separated values, tags stripped, blanks dropped. */
function cellParts($, td) {
  return ($(td).html() || '')
    .split(/<br\s*\/?>/i)
    .map(chunk => cheerio.load(`<div>${chunk}</div>`)('div').text().replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function parseRow($, tr) {
  const byX = new Map()
  $(tr).find('td[data-x]').each((_, td) => byX.set(Number($(td).attr('data-x')), td))
  if (byX.size === 0) return null

  // Day, month and year sit on separate lines of the cell, so read the parts and
  // rejoin them. Taking .text() would yield "03października2026".
  const date = parseDate(cellParts($, byX.get(1)).join(' '))
  if (!date) return null

  const icons = $(byX.get(0)).find('img')
    .map((_, img) => ($(img).attr('src') || '').split('/').pop())
    .get()
  if (icons.some(i => NON_RUNNING_ICONS.test(i))) return null

  // The place cell ends with the country. Foreign races share this calendar.
  const place = cellParts($, byX.get(2))
  if (!place.length || !/^POLSKA$/i.test(place[place.length - 1])) return null
  const city = place[0] || null

  const nameParts = cellParts($, byX.get(4))
  if (!nameParts.length) return null
  // The umbrella is the first line; the rest name the sub-races. A trailing colon
  // ("GDYNIA ULTRA WAY - WINTER RACE:") introduces them and is not part of the name.
  let name = nameParts[0].replace(/\s*:\s*$/, '').trim()
  if (isGenericHeading(name) && nameParts[1]) name = `${name} ${nameParts[1]}`.trim()
  if (!name) return null

  const distanceParts = cellParts($, byX.get(3))
  const blob = `${nameParts.join(' ')} ${distanceParts.join(' ')}`

  // The sign-up cell turns into a results link once the edition has been run.
  const signupCell = byX.get(7)
  const registrationUrl = signupCell && /zapisy/i.test($(signupCell).text())
    ? $(signupCell).find('a[href^="http"]').first().attr('href') || null
    : null

  // The name cell links to the organizer's own domain. When an event has no site of
  // its own the portal links its Facebook page instead, and that is still the
  // organizer's declared presence, so it is kept.
  let website = $(byX.get(4)).find('a[href^="http"]').filter((_, a) => !isOwnHost($(a).attr('href'))).first().attr('href') || null
  if (!website) website = $(byX.get(6)).find('a[href^="http"]').filter((_, a) => !isOwnHost($(a).attr('href'))).first().attr('href') || null

  return {
    name,
    date,
    location: city,
    distances: cleanDistances(distanceParts),
    registration_url: registrationUrl,
    registration_deadline: null,
    regulamin_url: null, // the portal links no rules document
    website,
    is_kids: hasKidsSignal(blob),
    event_types: detectEventTypes(icons, blob),
    price_from: null,
    price_to: null,
    source: 'biegigorskie',
    source_id: `${slugify(name)}-${date}`,
    source_url: null, // filled by the caller with the calendar page the row came from
  }
}

async function fetchYear(year) {
  const url = `${BASE}/kalendarz-${year}/`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) {
    console.warn(`[biegigorskie] ${url} → HTTP ${res.status}`)
    return []
  }
  const $ = cheerio.load(await res.text())
  const rows = []
  $('tr').each((_, tr) => {
    const row = parseRow($, tr)
    if (row) rows.push({ ...row, source_url: url })
  })
  console.log(`[biegigorskie] ${year}: ${rows.length} parsed`)
  return rows
}

export async function scrape({ knownIds } = {}) {
  const today = new Date().toISOString().split('T')[0]
  const now = new Date().getFullYear()
  const byId = new Map()

  for (const year of [now, now + 1]) {
    let rows = []
    try {
      rows = await fetchYear(year)
    } catch (err) {
      console.error(`[biegigorskie] ${year} failed: ${err.message}`)
      continue
    }
    for (const row of rows) {
      if (row.date < today) continue
      if (!byId.has(row.source_id)) byId.set(row.source_id, row)
    }
    await new Promise(r => setTimeout(r, 1100))
  }

  const events = [...byId.values()]
  const fresh = knownIds ? events.filter(e => !knownIds.has(e.source_id)) : events
  console.log(`[biegigorskie] ${events.length} future events (${fresh.length} new)`)
  return fresh
}

export { parseDate, cleanDistances, detectEventTypes, hasKidsSignal, isGenericHeading, parseRow, slugify }
