// Plus Timing — Wielkopolska (Poznań-area) timing company.
//
// Data source: a single JSON API powers the DataTables listing on /zapisy.
//   https://wyniki.plus-timing.pl/api/api_dt.php?action=api_get_zapisy_biegi
// Every field comes from that one call — no detail-page fetches needed. The page
// itself is NOT WordPress (no wp-json) and renders the table client-side.
//
// Registration is hosted by plus-timing itself at /zgloszenia/<slug>/ — verified
// event-specific (title "<event> - Zgłoszenia", name+city+date+distances in the
// ISO-8859-2 body, e.g. "XII Wroniecka Dycha … Wronki, 21.06.2026 … Dystans: …").
// So registration_url = source_url = that hosted form page. regulamin_url and the
// organizer website (`organizator_strona`) come straight from the API.
//
// Multi-sport company (MTB / gravel / triathlon / kolarstwo / aquathlon all appear
// in the feed) → RUNNING-DISCIPLINE WHITELIST on `dyscyplina`: only "bieg uliczny"
// and "bieg(i) przełajow*" are kept. Dropped: MTB, zawody gravelowe, triathlon,
// kolarstwo, sztafeta (aquathlon), BnO (orienteering) and standalone "zawody dla
// dzieci" — the kids/BnO rows are sub-variants of running umbrellas that are already
// captured (e.g. "Forest Run 2026 KIDS" under "Forest Run 2026"), or are attached to
// non-running events (e.g. "ENEA Junior Poznań Triathlon"). is_kids is recovered from
// a kids sibling row that shares the umbrella's base name. Undated rows (0000-00-00,
// far-future events with no date set yet) are dropped per the no-date rule.
//
// Prices and deadlines are NOT in the API (no price/deadline fields) → left null for
// the Python enricher to fill from the regulamin. Registration is plus-timing-hosted,
// not dostartu, so the pipeline's dostartu apiEnrich won't touch these rows.

const API_URL = 'https://wyniki.plus-timing.pl/api/api_dt.php?cachetimeout=10&action=api_get_zapisy_biegi'
const UA = 'leszy.run/1.0 (kontakt@leszy.run)'

const RUNNING_DISCIPLINES = new Set(['bieg uliczny', 'bieg przełajowy', 'biegi przełajowe'])

// JS \b doesn't recognize Polish letters — use a manual non-letter boundary.
const NB = '[^a-ząćęłńóśźż]'

function parseLinks(raw) {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function firstLink(raw) {
  const link = parseLinks(raw).find(x => x && x.link)
  return link ? link.link.trim() : null
}

// "https://plus-timing.pl/zgloszenia/wroniecka_dycha-2026" → "wroniecka_dycha-2026"
function slugFromRegistration(url, fallbackName) {
  const m = (url || '').match(/\/zgloszenia\/([^/?#]+)/i)
  if (m) return m[1]
  return (fallbackName || '')
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, c => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[c] || c))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function isValidDate(d) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  if (d.startsWith('0000')) return false
  const year = Number(d.slice(0, 4))
  return year >= 2024 && year <= 2100
}

// "Bieg 10 km | Bieg 5 km | Nordic Walking 5 km" → "10 km, 5 km"
// "5 km | 10 km | 21,1 km" → "5 km, 10 km, 21.1 km" (Polish decimal comma → dot)
// "150 m | 300 m | 600 m" → "150 m, 300 m, 600 m"
function cleanDistances(raw) {
  if (!raw) return null
  const out = []
  const seen = new Set()
  for (let part of raw.split('|')) {
    part = part
      .replace(/nordic\s*walking/gi, '')
      .replace(new RegExp(`${NB}?bieg${NB}`, 'gi'), ' ')
      .replace(new RegExp(`${NB}?nw${NB}`, 'gi'), ' ')
      .replace(/(\d),(\d)/g, '$1.$2') // 21,1 → 21.1
      .trim()
    const km = part.match(/(\d+(?:\.\d+)?)\s*km/i)
    const m = part.match(/(\d+)\s*m\b/i)
    let val = null
    if (km) val = `${km[1]} km`
    else if (m) val = `${m[1]} m`
    if (val && !seen.has(val)) {
      seen.add(val)
      out.push(val)
    }
  }
  return out.length ? out.join(', ') : null
}

function detectEventTypes(blob, dyscyplina) {
  const s = `${blob || ''} ${dyscyplina || ''}`.toLowerCase()
  const disc = (dyscyplina || '').toLowerCase()
  const tags = new Set()
  // Base type from the discipline — a road race stays "uliczny" even when it also
  // offers an NW category. (uliczny is ignored by the merge guard, only used for display.)
  if (/przełaj/.test(disc)) tags.add('trail')
  else if (/uliczn/.test(disc)) tags.add('uliczny')
  // Additive styles mined from name + distances + discipline.
  if (/przełaj|g[oó]rsk|leśn|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(s)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b|marsz\s+z\s+kijami/i.test(s)) tags.add('nordic walking')
  if (/\bultra\b/i.test(s)) tags.add('ultra')
  if (/\bocr\b/i.test(s)) tags.add('ocr')
  if (/nocn/i.test(s)) tags.add('nocny')
  return [...tags]
}

function hasKidsSignal(name) {
  if (!name) return false
  const s = ` ${name.toLowerCase()} `
  if (/(?:biegi|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  return false
}

// Strip kids/sub-variant suffixes so a kids sub-event can be matched to its
// running umbrella by base name.
function umbrellaBase(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\s*-\s*biegi\s+dzieci.*$/i, '')
    .replace(/\s*-\s*bieg\s+rodzinny.*$/i, '')
    .replace(/\s+kids\b.*$/i, '')
    .replace(/\s*-\s*kids\b.*$/i, '')
    .trim()
}

export async function scrape({ knownIds } = {}) {
  const res = await fetch(API_URL, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`plustiming API ${res.status}`)
  const json = await res.json()
  const rows = Array.isArray(json.data) ? json.data : []

  // First pass: collect base names of every kids-signal row so we can flag the
  // matching running umbrella as is_kids.
  const kidsBases = new Set()
  for (const r of rows) {
    const disc = (r.dyscyplina || '').toLowerCase()
    if (disc === 'zawody dla dzieci' || hasKidsSignal(r.nazwa_biegu)) {
      const base = umbrellaBase(r.nazwa_biegu)
      if (base) kidsBases.add(base)
    }
  }

  const events = []
  for (const r of rows) {
    const name = (r.nazwa_biegu || '').trim()
    const date = (r.data_biegu || '').trim()
    const disc = (r.dyscyplina || '').toLowerCase()

    if (!name || !isValidDate(date)) continue
    if (!RUNNING_DISCIPLINES.has(disc)) continue // running-only whitelist

    const registration_url = firstLink(r.linki_do_zapisow)
    const source_id = slugFromRegistration(registration_url, name)

    let website = (r.organizator_strona || '').trim() || null
    if (website && /plus-timing\.pl/i.test(website)) website = null // never the timing platform itself

    const nameLc = name.toLowerCase()
    const is_kids =
      hasKidsSignal(name) ||
      [...kidsBases].some(base => base !== '' && (base === nameLc || base.startsWith(nameLc) || nameLc.startsWith(base)))

    events.push({
      name,
      date,
      location: (r.miejscowosc || '').trim() || null,
      distances: cleanDistances(r.dystans_biegu_txt),
      registration_url,
      registration_deadline: null, // not in API — enricher fills from regulamin
      regulamin_url: firstLink(r.linki_do_regulaminow),
      website,
      is_kids,
      event_types: detectEventTypes(`${name} ${r.dystans_biegu_txt || ''}`, disc),
      price_from: null, // not in API
      price_to: null,
      source: 'plustiming',
      source_id,
      source_url: registration_url,
    })
  }

  return events
}
