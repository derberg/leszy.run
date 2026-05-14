import * as cheerio from 'cheerio'

const LISTING_URL = 'https://czasomierzyk.pl/zapisy/'
const FORMULARZ_BASE = 'https://formularz.czasomierzyk.pl'

// Aggregate/gender rows in the participant count table — not event categories
const SKIP_ROWS = new Set(['zapisani zawodnicy', 'wszyscy zawodnicy', 'mężczyźni', 'kobiety'])

function detectEventTypes(name) {
  const blob = (name || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|le[sś]n[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b/i.test(blob)) tags.add('ocr')
  return [...tags]
}

// \b doesn't recognize Polish letters in JS — use manual non-letter boundary
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

// Take city portion (before first comma) for geocoding
function parseLocation(raw) {
  if (!raw) return null
  const comma = raw.indexOf(',')
  return comma > 0 ? raw.slice(0, comma).trim() : raw.trim()
}

async function fetchFormularz(id) {
  try {
    const res = await fetch(`${FORMULARZ_BASE}/${id}`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) return null

    const html = await res.text()
    const $ = cheerio.load(html)

    const distances = new Set()
    let regulaminUrl = null

    // Extract distances and kids signal from participant count table categories.
    // Table structure: category_name | total | paid | unpaid
    // We only want the first column of each data row.
    $('table tr').each((_, row) => {
      const cells = $(row).find('td')
      if (cells.length < 2) return

      const cat = $(cells.first()).text().trim()
      if (!cat) return
      if (SKIP_ROWS.has(cat.toLowerCase())) return

      const kmMatch = cat.match(/(\d+(?:[.,]\d+)?)\s*km\b/i)
      if (kmMatch) {
        distances.add(`${kmMatch[1].replace(',', '.')} km`)
        return
      }
      const mMatch = cat.match(/^.*?(\d+)\s*m\b/)
      if (mMatch) {
        distances.add(`${mMatch[1]} m`)
      }
    })

    // Regulamin link: <a href="uploads/regulations/<id>_filename.pdf">Regulamin</a>
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || ''
      const text = $(el).text().trim()
      if (text === 'Regulamin' && href.includes('regulations/')) {
        const encoded = href.replace(/ /g, '%20')
        regulaminUrl = href.startsWith('http')
          ? encoded
          : `${FORMULARZ_BASE}/${encoded.replace(/^\//, '')}`
      }
    })

    return {
      distances: [...distances].join(', ') || null,
      regulaminUrl,
    }
  } catch (err) {
    console.warn(`[czasomierzyk] Error fetching formularz ${id}: ${err.message}`)
    return null
  }
}

/**
 * Scrape czasomierzyk.pl/zapisy/ — small timing company registration portal.
 * Mazowsze-area events; HTML table with date, location, name columns.
 * Registration forms at formularz.czasomierzyk.pl/<numeric-id>.
 * Verified: date in YYYY-MM-DD format directly in listing; registration URL
 * confirmed via curl -sIL returning 200 with event-specific content.
 */
export async function scrape({ knownIds = new Set() } = {}) {
  const today = new Date().toISOString().split('T')[0]
  const results = []

  try {
    const res = await fetch(LISTING_URL, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) {
      console.error(`[czasomierzyk] Listing page returned ${res.status}`)
      return results
    }

    const html = await res.text()
    const $ = cheerio.load(html)

    const entries = []

    // Event table: Data (date) | Miejscowość (location) | Nazwa (name)
    // All cells link to formularz.czasomierzyk.pl/<id>
    $('table tr').each((_, row) => {
      const cells = $(row).find('td')
      if (cells.length < 3) return

      const date = $(cells.eq(0)).text().trim().slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return
      if (date < today) return

      const locationRaw = $(cells.eq(1)).text().trim()
      const name = $(cells.eq(2)).text().trim()
      if (!name) return

      const href = $(cells.eq(0)).find('a').attr('href') || ''
      if (!href.includes('formularz.czasomierzyk.pl')) return

      const sourceId = href.split('/').pop()
      if (!sourceId || !/^\d+$/.test(sourceId)) return

      entries.push({ name, date, location: parseLocation(locationRaw), sourceId })
    })

    console.log(`[czasomierzyk] Found ${entries.length} future events on listing`)

    const fresh = entries.filter(e => !knownIds.has(e.sourceId))
    console.log(`[czasomierzyk] ${fresh.length} new events to process`)

    for (const entry of fresh) {
      const detail = await fetchFormularz(entry.sourceId)

      results.push({
        name: entry.name,
        date: entry.date,
        location: entry.location,
        distances: detail?.distances || null,
        registration_url: `${FORMULARZ_BASE}/${entry.sourceId}`,
        regulamin_url: detail?.regulaminUrl || null,
        is_kids: hasKidsSignal(entry.name),
        event_types: detectEventTypes(entry.name),
        source: 'czasomierzyk',
        source_id: entry.sourceId,
        source_url: `${FORMULARZ_BASE}/${entry.sourceId}`,
      })

      await new Promise(r => setTimeout(r, 800))
    }

    console.log(`[czasomierzyk] Scraped ${results.length} new events`)
  } catch (err) {
    console.error(`[czasomierzyk] Scrape failed: ${err.message}`)
  }

  return results
}
