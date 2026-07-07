// Biegnijmy.pl ("Rozbiegany Koszalin") — regional running portal for Koszalin /
// Zachodniopomorskie (Białogard, Świdwin, Tychowo, Karlino, Manowo, Świeszyno,
// Połczyn-Zdrój, …). Custom PHP site, not WordPress permalinks.
//
// Data source: the events calendar at index.php?plik=imprezy&co=<YEAR>- renders one
// `<tr class="bieg">` per event, fully server-side. Each row carries everything we
// need — no detail-page fetches:
//   - td.czarny            → event name
//   - a "YYYY-MM-DD, City"  → clean ISO date + city
//   - "Dystans:" row        → distances (with bieg/NW/kids qualifiers inline)
//   - "Organizator:" row    → organizer (unused)
//   - anchors STRONA BIEGU / REGULAMIN / ZAPISY
//   - "ID#YYYYMMDD-n"        → stable id; the ZAPISY href encodes <id>-<city>
//
// URLs:
//   - source_url = the ZAPISY page biegnijmy.pl/index.php?kat=zapisy/<id>-<city>&plik=zapisy
//     (verified event-specific — title/heading name the event). It's an INFO page
//     (regulamin + organizer), NOT a registration form, and exposes no reliable
//     per-event external signup link → registration_url is left null for the
//     enricher's search step to fill.
//   - regulamin_url = biegnijmy-hosted PDF when present (verified content-type=pdf).
//   - website = STRONA BIEGU declared official link (kept even if it's a Facebook
//     org page, per the declared-official-link rule; only biegnijmy's own host stripped).
//
// This is a regional listing/aggregator (registration lives elsewhere) → priority 8.
//
// RUNNING FILTER: biegnijmy has no discipline field, so non-running events are
// dropped by name keyword — cycling ("rowerowy"/"kolarski"/MTB), triathlon/duathlon,
// swimming, skiing — and CANCELLED events ("odwołane"). Mixed bieg+marsz+rower events
// keep their running distances (cycling segments stripped from the distances string).
// voivodeship left null → geocoded from city. prices/deadline → enricher.

import * as cheerio from 'cheerio'

const BASE = 'https://biegnijmy.pl'
const UA = 'leszy.run/1.0 (kontakt@leszy.run)'

// JS \b doesn't recognize Polish letters — use a manual non-letter boundary.
const NB = '[^a-ząćęłńóśźż]'

const NON_RUNNING_NAME = /rowerow|kolarsk|\bmtb\b|\brajd\s+rowerow|triathlon|duathlon|aquathlon|pływan|kajak|narciar|\bnordic\s*ski/i
const CANCELLED = /odwoł|odwolan/i

const slugify = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, c => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[c] || c))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

function cleanCity(raw) {
  if (!raw) return null
  let c = raw
    .replace(/\(.*$/s, '') // drop from first "(" on — "Dębowa Góra (gm. Wyrzysk)" → "Dębowa Góra"
    .split(/\s[-–]\s/)[0] // "Strzekęcino - Szosa Leśna" → "Strzekęcino"
    .split('!')[0] // "Białogard!!! UWAGA…" → "Białogard"
    .replace(/\bUWAGA\b.*$/is, '')
    .replace(/\s+/g, ' ')
    .trim()
  return c || null
}

// "10 km (bieg), 5 km (NW), 1,2 km (młodzież), 800 m, 400 m, 200 m, 100 m (dzieci)"
//   → "10 km, 5 km, 1.2 km, 800 m, 400 m, 200 m, 100 m"
// "200, 400, 800, 1200 m, 5 km" → trailing unit applies to preceding bare numbers
// cycling segments ("rower 9.5 km", "Rajd ...", "35 km MINI" in a Rowerowy event) dropped
function cleanDistances(raw) {
  if (!raw) return null
  // Polish decimal comma → dot BEFORE splitting on list commas ("1,2 km" vs "5 km, 10 km")
  const s = raw.replace(/(\d),(\d)/g, '$1.$2')
  const tokens = s.split(',').map(t => t.trim()).filter(Boolean)
  const out = []
  const seen = new Set()
  let bareQueue = []
  const push = (n, unit) => {
    const val = `${n} ${unit}`
    if (!seen.has(val)) { seen.add(val); out.push(val) }
  }
  for (let tok of tokens) {
    if (/rower|rajd|\bmtb\b|kolarsk/i.test(tok)) { bareQueue = []; continue } // cycling segment
    tok = tok
      .replace(/\([^)]*\)/g, '') // strip qualifiers (bieg)/(NW)/(dzieci)/(Cross)/...
      .replace(new RegExp(`${NB}?(?:bieg|marsz|nordic\\s*walking|plus|mini|mega|open)${NB}?`, 'gi'), ' ')
      .trim()
    const km = tok.match(/(\d+(?:\.\d+)?)\s*km/i)
    const m = tok.match(/(\d+(?:\.\d+)?)\s*m\b/i)
    if (km) {
      bareQueue.forEach(n => push(n, 'km')) // bare numbers before a km token = km
      bareQueue = []
      push(km[1], 'km')
    } else if (m) {
      bareQueue.forEach(n => push(n, 'm'))
      bareQueue = []
      push(m[1], 'm')
    } else {
      const bare = tok.match(/^(\d+(?:\.\d+)?)$/)
      if (bare) bareQueue.push(bare[1])
    }
  }
  return out.length ? out.join(', ') : null
}

function detectEventTypes(blob) {
  const s = (blob || '').toLowerCase()
  const tags = new Set()
  if (/przełaj|g[oó]rsk|leśn|\blas\b|lasku|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(s)) tags.add('trail')
  if (new RegExp(`nordic\\s*walking|${NB}nw${NB}|marsz\\s*nw|marsz\\s+z\\s+kijami`, 'i').test(` ${s} `)) tags.add('nordic walking')
  if (/\bultra\b/i.test(s)) tags.add('ultra')
  if (/\bocr\b/i.test(s)) tags.add('ocr')
  if (/charytatywn|wośp|pustego grobu|hospic/i.test(s)) tags.add('charytatywny')
  if (/nocn/i.test(s)) tags.add('nocny')
  if (/uliczn/i.test(s)) tags.add('uliczny')
  if (tags.size === 0 || (tags.size === 1 && tags.has('charytatywny'))) tags.add('uliczny')
  return [...tags]
}

function hasKidsSignal(blob) {
  if (!blob) return false
  const s = ` ${blob.toLowerCase()} `
  if (/(?:biegi|bieg|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}świetlik`).test(s)) return true
  return false
}

function isValidDate(d) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const year = Number(d.slice(0, 4))
  return year >= 2024 && year <= 2100
}

async function fetchYear(year) {
  const url = `${BASE}/index.php?plik=imprezy&co=${year}-`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) return []
  const html = await res.text()
  const $ = cheerio.load(html)
  const rows = []

  $('tr.bieg').each((_, el) => {
    const r = $(el)
    const szczegoly = r.find('td.szczegoly')
    if (!szczegoly.length) return

    const name = szczegoly.find('td.czarny').first().text().replace(/\s+/g, ' ').trim()
    if (!name) return

    // ISO date + city cell
    let dateCity = ''
    szczegoly.find('td').each((__, td) => {
      const t = $(td).text().trim()
      if (/^\d{4}-\d{2}-\d{2},/.test(t)) dateCity = t
    })
    const dm = dateCity.match(/^(\d{4}-\d{2}-\d{2}),\s*(.+)$/)
    if (!dm) return
    const date = dm[1]
    const city = cleanCity(dm[2])

    // labeled rows: Dystans / Organizator
    let distances = null
    szczegoly.find('tr').each((__, tr) => {
      const tds = $(tr).find('td')
      if (tds.length >= 2 && /^Dystans/i.test($(tds[0]).text().trim())) {
        distances = $(tds[1]).text().replace(/\s+/g, ' ').trim()
      }
    })

    // links by anchor text
    let regulamin_url = null
    let website = null
    let zapisySlug = null
    r.find('a').each((__, a) => {
      const t = $(a).text().trim().toUpperCase()
      const href = ($(a).attr('href') || '').trim()
      if (!href) return
      if (/REGULAMIN/.test(t) && /\.pdf$/i.test(href)) regulamin_url = href
      else if (/STRONA\s*BIEGU/.test(t)) website = href
      else if (/ZAPIS/.test(t)) {
        const sm = href.match(/kat=zapisy\/([^&]+)/i)
        if (sm) zapisySlug = sm[1]
      }
    })

    const idMatch = r.text().match(/ID#(\d{8}-\d+)/)
    const id = idMatch ? idMatch[1] : null
    const source_id = zapisySlug || (id ? `${id}-${slugify(city || '')}` : slugify(`${name}-${date}`))
    const source_url = `${BASE}/index.php?kat=zapisy/${source_id}&plik=zapisy`

    if (website && /biegnijmy\.pl/i.test(website)) website = null // never the portal itself

    rows.push({ name, date, city, distances, regulamin_url, website, source_id, source_url })
  })

  return rows
}

export async function scrape({ knownIds } = {}) {
  const now = new Date()
  const years = [now.getFullYear(), now.getFullYear() + 1]
  const byId = new Map()
  for (const y of years) {
    for (const row of await fetchYear(y)) {
      if (!byId.has(row.source_id)) byId.set(row.source_id, row)
    }
  }

  const events = []
  for (const r of byId.values()) {
    if (!isValidDate(r.date)) continue
    if (CANCELLED.test(r.name)) continue
    if (NON_RUNNING_NAME.test(r.name)) continue

    const blob = `${r.name} ${r.distances || ''}`
    events.push({
      name: r.name,
      date: r.date,
      location: r.city || null,
      distances: cleanDistances(r.distances),
      registration_url: null, // ZAPISY page is info-only; enricher finds the real one
      registration_deadline: null,
      regulamin_url: r.regulamin_url || null,
      website: r.website || null,
      is_kids: hasKidsSignal(blob),
      event_types: detectEventTypes(blob),
      price_from: null,
      price_to: null,
      source: 'biegnijmy',
      source_id: r.source_id,
      source_url: r.source_url,
    })
  }

  return events
}
