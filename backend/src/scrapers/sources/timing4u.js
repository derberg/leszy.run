import * as cheerio from 'cheerio'

const LIST_URL = 'https://timing4u.pl/?page_id=173'
const USER_AGENT = 'leszy.run/1.0 (kontakt@leszy.run)'

// Skip non-running events (triathlon, cycling)
const SKIP_PATTERN = /triathl[oa]n|kolarsk[aiey]|rowerow[aey]?|\bmtb\b/i

function detectEventTypes(name) {
  const blob = (name || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|le[sś]n[aey]|\btrail\b|cross(?:owy|owa|owe)?\b|przełaj/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b/i.test(blob)) tags.add('ocr')
  return [...tags]
}

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

async function scrape({ knownIds = new Set() } = {}) {
  let html
  try {
    const res = await fetch(LIST_URL, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) throw new Error(`listing ${res.status} ${res.statusText}`)
    html = await res.text()
  } catch (err) {
    console.error('[timing4u] Listing fetch failed:', err.message)
    return []
  }

  const $ = cheerio.load(html)
  const results = []
  let skipped = 0

  $('table tr').each((_, el) => {
    const tds = $(el).find('td')
    if (tds.length < 3) return

    const date = $(tds[0]).text().trim()
    const name = $(tds[1]).text().trim()
    const location = $(tds[2]).text().trim()

    if (!date || !name) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return

    if (SKIP_PATTERN.test(name)) {
      skipped++
      return
    }

    // Registration URL from onclick="window.open('<url>', '_blank')"
    const onclick = $(el).attr('onclick') || ''
    const urlMatch = onclick.match(/window\.open\('([^']+)'/)
    if (!urlMatch) return
    const registrationUrl = urlMatch[1]

    // Stable source_id: URL without protocol
    const sourceId = registrationUrl.replace(/^https?:\/\//, '')

    if (knownIds.has(sourceId)) return

    results.push({
      name,
      date,
      location: location || null,
      distances: null,
      registration_url: registrationUrl,
      registration_deadline: null,
      regulamin_url: null,
      website: null,
      is_kids: hasKidsSignal(name),
      event_types: detectEventTypes(name),
      price_from: null,
      price_to: null,
      source: 'timing4u',
      source_id: sourceId,
      source_url: LIST_URL,
    })
  })

  console.log(`[timing4u] Listing: ${results.length + skipped} events, ${skipped} skipped, ${results.length} new`)
  return results
}

export { scrape }
