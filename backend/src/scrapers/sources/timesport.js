import * as cheerio from 'cheerio'

// time-sport.pl — Time-Sport, RFID timing company (Śląsk-based, nationwide coverage).
// Events live in a server-rendered NinjaTable on /zapisy/ (FooTable, table_id 2823).
// Columns: data (DD.MM.YYYY) | dyscyplina | name | city | województwo | "ZAPISZ SIĘ".
// Each row carries THREE anchors: /info/<city>/, /info/<voivodeship>/, and the canonical
// per-event detail page /zapisy-DD-MM-YYYY-<slug>/ (3rd anchor) — that's source_url + source_id.
//
// Registration URL — verification notes (per CLAUDE.md "URL verification"):
//   The canonical detail page reliably exposes the dostartu statute PDF
//   (https://dostartu.pl/statute_files/<id>_pl.pdf) in static HTML. We extract the numeric
//   dostartu id from it and emit registration_url = https://dostartu.pl/zawody/<id>.
//   - Verified: fetchCompetition('16621') from dostartu.js resolves to "VI PYSKOWICKI BIEG
//     MAMUTA" / Pyskowice (the right event), and apiEnrich's extractDostartuId already
//     supports the /zawody/(\d+) form → the pipeline auto-enriches prices/distances/deadline/
//     regulamin/website from the dostartu API.
//   - Ruled out: deriving the /YYYY/zapisy/zapisy-<nameslug>.html embed page (it carries the
//     pretty -v<id> link) — that derivation FAILED on a 2nd event, so it's unreliable.
//   - Ruled out: reverse-engineering dostartu.pl/<slug>-v<id> — we never have the dostartu slug.
//   Fallback when no dostartu statute PDF is present: any elektronicznezapisy/b4sport/datasport
//   registration link found on the detail page, else the time-sport canonical detail page itself.

const BASE = 'https://time-sport.pl'
const LISTING = 'https://time-sport.pl/zapisy/'
// NinjaTables randomizes the ninja_table_unique_id_<rand>_2823 class per page load;
// data-footable_id / foo_table_2823 (the table id 2823) is the stable selector.
const TABLE_RE = /<table[^>]*(?:data-footable_id="2823"|foo_table_2823)[^>]*>([\s\S]*?)<\/table>/i
const UA = 'leszy.run/1.0 (kontakt@leszy.run)'

// Discipline ("dyscyplina" column) gating.
const SKIP_DISC = /mtb|triath|p[lł]ywan|kolar|rower/i
const KEEP_DISC = /bieg|ocr|nordic|trail|marsz/i
// Rescue by name when discipline is ambiguous ("Inne" etc.)
const RUNNING_NAME = /bieg|maraton|p[oó][lł]maraton|marsz\s+z\s+kijami|nordic|trail|cross|ocr/i

function isRunning(disc, name) {
  const d = disc || ''
  if (SKIP_DISC.test(d)) return false
  if (KEEP_DISC.test(d)) return true
  return RUNNING_NAME.test(name || '')
}

// "05.09.2026" → "2026-09-05"
function parseDate(raw) {
  const m = (raw || '').match(/(\d{2})\.(\d{2})\.(\d{4})/)
  if (!m) return null
  return `${m[3]}-${m[2]}-${m[1]}`
}

// "ŚLĄSKIE" → "Śląskie", "KUJAWSKO-POMORSKIE" → "Kujawsko-Pomorskie"
function titleCase(s) {
  if (!s) return null
  return s
    .toLowerCase()
    .replace(/(^|[\s-])([a-ząćęłńóśźż])/g, (_, sep, ch) => sep + ch.toUpperCase())
    .trim()
}

// event_types — see adding-a-new-scraper §5b. Detected from the umbrella name only.
function detectEventTypes(blob) {
  const s = (blob || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|leśn[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(s)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b|marsz\s+z\s+kijami/i.test(s)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(s)) tags.add('ultra')
  if (/\bocr\b/i.test(s)) tags.add('ocr')
  return [...tags]
}

// is_kids — see adding-a-new-scraper §5b. JS \b doesn't recognize Polish letters.
const NB = '[^a-ząćęłńóśźż]'
function hasKidsSignal(name) {
  if (!name) return false
  const s = ` ${name.toLowerCase()} `
  if (/(?:biegi|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}świetlik`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

// Split a name cell whose sub-races are separated by <br> into clean lines.
function nameLinesFromCell($, cell) {
  const html = ($(cell).html() || '').replace(/<br\s*\/?>/gi, '\n')
  return cheerio
    .load(`<div>${html}</div>`)('div')
    .text()
    .split('\n')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

// Pull registration + regulamin from a canonical detail page.
async function fetchDetail(detailUrl) {
  try {
    const res = await fetch(detailUrl, { headers: { 'User-Agent': UA } })
    const html = await res.text()

    // 1) dostartu statute PDF → numeric id → /zawody/<id> (apiEnrich-friendly)
    const statute = html.match(/https?:\/\/dostartu\.pl\/statute_files\/(\d+)_[a-z]{2}\.pdf/i)
    if (statute) {
      return {
        registration_url: `https://dostartu.pl/zawody/${statute[1]}`,
        regulamin_url: statute[0],
      }
    }

    // 2) a direct dostartu -v<id> link if present anywhere
    const dostartuV = html.match(/https?:\/\/dostartu\.pl\/[a-z0-9-]+-v\d+/i)
    if (dostartuV) return { registration_url: dostartuV[0], regulamin_url: null }

    // 3) other known registration platforms
    const other = html.match(
      /https?:\/\/(?:[a-z0-9-]+\.)?(?:elektronicznezapisy\.pl|datasport\.pl|b4sportonline\.pl)\/[^\s"'<)]+/i
    )
    if (other) return { registration_url: other[0], regulamin_url: null }

    return { registration_url: null, regulamin_url: null }
  } catch (err) {
    console.error(`[timesport] Detail fetch failed for ${detailUrl}:`, err.message)
    return { registration_url: null, regulamin_url: null }
  }
}

async function scrape({ knownIds = new Set() } = {}) {
  let html
  try {
    const res = await fetch(LISTING, { headers: { 'User-Agent': UA } })
    html = await res.text()
  } catch (err) {
    console.error('[timesport] Listing fetch failed:', err.message)
    return []
  }

  const tableMatch = html.match(TABLE_RE)
  if (!tableMatch) {
    console.error('[timesport] NinjaTable (id 2823) not found on /zapisy/')
    return []
  }

  // Wrap the inner HTML back in <table> — parse5 fosters (drops) <tr>/<tbody>
  // that aren't inside a <table> ancestor.
  const $ = cheerio.load(`<table>${tableMatch[1]}</table>`)
  const entries = []

  $('tr').each((_, tr) => {
    const cells = $(tr).find('td')
    if (cells.length < 5) return

    const dateRaw = $(cells[0]).text().trim()
    const disc = $(cells[1]).text().trim()
    // The name cell lists sub-races separated by <br>. The umbrella (first line) is the
    // event name; the full multi-line text drives is_kids detection (kids sub-races like
    // "Młyn Kids" / "Bieg Dzieci" live on later lines).
    const nameLines = nameLinesFromCell($, cells[2])
    const name = nameLines[0] || ''
    const nameFull = nameLines.join(' ')
    const city = $(cells[3]).text().replace(/\s+/g, ' ').trim()
    const voiv = $(cells[4]).text().replace(/\s+/g, ' ').trim()

    const date = parseDate(dateRaw)
    if (!name || !date) return
    if (!isRunning(disc, name)) return

    // Canonical per-event detail page: the /zapisy-DD-MM-YYYY-<slug>/ anchor in the row.
    let detailUrl = null
    $(tr)
      .find('a[href]')
      .each((__, a) => {
        if (detailUrl) return
        const href = $(a).attr('href') || ''
        if (/\/zapisy-\d{2}-\d{2}-\d{4}-[a-z0-9-]+\/?$/i.test(href)) {
          detailUrl = href.startsWith('http') ? href : `${BASE}${href}`
        }
      })

    // Some rows link directly to dostartu instead of an internal detail page.
    let directReg = null
    $(tr)
      .find('a[href*="dostartu.pl"]')
      .each((__, a) => {
        if (directReg) return
        directReg = $(a).attr('href')
      })

    if (!detailUrl && !directReg) return

    const slug = detailUrl
      ? detailUrl.replace(/\/$/, '').split('/').pop()
      : `direct-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${date}`

    entries.push({
      name,
      nameFull,
      date,
      city,
      voivodeship: titleCase(voiv),
      detailUrl,
      directReg,
      slug,
    })
  })

  const newEntries = entries.filter(e => !knownIds.has(e.slug))
  console.log(
    `[timesport] Found ${entries.length} running events, ${newEntries.length} new (skipping ${entries.length - newEntries.length} known)`
  )

  const results = []
  for (const e of entries) {
    let registration_url = e.directReg || null
    let regulamin_url = null

    // Only fetch detail pages for NEW events (timekeeper knownIds pattern) — avoids
    // re-fetching and avoids nulling registration data on known rows.
    if (!knownIds.has(e.slug) && !registration_url && e.detailUrl) {
      const detail = await fetchDetail(e.detailUrl)
      registration_url = detail.registration_url
      regulamin_url = detail.regulamin_url
      await new Promise(r => setTimeout(r, 1100))
    }

    const eventTypes = detectEventTypes(e.name)

    results.push({
      name: e.name,
      date: e.date,
      location: titleCase(e.city) || null,
      voivodeship: e.voivodeship || null,
      distances: null, // not in listing; dostartu apiEnrich + python enricher fill
      registration_url: registration_url || e.detailUrl || null,
      regulamin_url,
      website: null,
      is_kids: hasKidsSignal(e.nameFull),
      event_types: eventTypes.length ? eventTypes : null,
      source: 'timesport',
      source_id: e.slug,
      source_url: e.detailUrl || registration_url || null,
    })
  }

  console.log(`[timesport] Scraped ${results.length} events`)
  return results
}

export { scrape }
