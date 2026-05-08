import * as cheerio from 'cheerio'

const BASE_URL = 'https://sport-time.com.pl'
const LIST_URL = `${BASE_URL}/zapisy-online`
const USER_AGENT = 'leszy.run/1.0 (kontakt@leszy.run)'

// DD/MM/YYYY → YYYY-MM-DD
function parseDate(raw) {
  if (!raw) return null
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

// Extract distance strings from event name, e.g. "BIEG 10 km" → "10 km",
// "NORDIC WALKING 3,3 km" → "3.3 km", "Dycha" → "10 km".
function distancesFromName(name) {
  if (!name) return []
  const out = new Set()
  const numRe = /(\d+(?:[.,]\d+)?)\s*km\b/gi
  for (const m of name.matchAll(numRe)) {
    const num = m[1].replace(',', '.')
    out.add(`${parseFloat(num)} km`)
  }
  if (out.size === 0 && /\bdycha\b/i.test(name)) out.add('10 km')
  return [...out]
}

// Detect event_types from umbrella/full name. Mirrors distinguishingTags() categories.
function detectEventTypes(name) {
  const blob = (name || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|leśn[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b/i.test(blob)) tags.add('ocr')
  return [...tags]
}

// Kids signal — \b doesn't handle Polish letters, use manual non-letter boundary.
function hasKidsSignal(name) {
  if (!name) return false
  const s = ` ${name.toLowerCase()} `
  const NB = '[^a-ząćęłńóśźż]'
  if (/(?:biegi|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}świetlik`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

async function scrape({ knownIds = new Set() } = {}) {
  const results = []

  let html
  try {
    const res = await fetch(LIST_URL, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) throw new Error(`listing ${res.status} ${res.statusText}`)
    html = await res.text()
  } catch (err) {
    console.error('[sporttime] Listing fetch failed:', err.message)
    return []
  }

  const $ = cheerio.load(html)

  $('div.competition').each((_, el) => {
    const article = $(el)

    const nameEl = article.find('header p a[href*="competitions/view"]').first()
    const name = nameEl.text().trim()
    if (!name) return

    const href = nameEl.attr('href') || ''
    const idMatch = href.match(/[?&]id=(\d+)/)
    if (!idMatch) return
    const sourceId = idMatch[1]

    // Right column <p> contains: location<br>date<br>deadline<br>status
    const valuesHtml = article.find('.large-7.columns p, .large-7.small-7.columns p').first().html() || ''
    const parts = valuesHtml
      .split(/<br\s*\/?>/i)
      .map(s => cheerio.load(s).text().trim())
      .filter(Boolean)

    // parts[0]=location, parts[1]=date (DD/MM/YYYY), parts[2]=deadline, parts[3]=status
    const location = parts[0] || null
    const date = parseDate(parts[1])
    if (!date) return

    const distances = distancesFromName(name)
    const eventTypes = detectEventTypes(name)

    results.push({
      name,
      date,
      location,
      distances: distances.length ? distances.join(', ') : null,
      registration_url: `${BASE_URL}/competitionUsers/checkIn?competitionId=${sourceId}`,
      // viewTerms renders the regulamin as HTML (not a PDF)
      regulamin_url: `${BASE_URL}/competitions/viewTerms?id=${sourceId}`,
      website: null,
      is_kids: hasKidsSignal(name),
      event_types: eventTypes.length ? eventTypes : null,
      price_from: null,
      price_to: null,
      source: 'sporttime',
      source_id: sourceId,
      source_url: `${BASE_URL}/competitions/view?id=${sourceId}`,
    })
  })

  const newResults = results.filter(r => !knownIds.has(r.source_id))
  console.log(`[sporttime] Listing: ${results.length} events, ${newResults.length} new`)
  return newResults
}

export { scrape, parseDate, distancesFromName, detectEventTypes, hasKidsSignal }
