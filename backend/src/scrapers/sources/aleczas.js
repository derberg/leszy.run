import * as cheerio from 'cheerio'

const LIST_URL = 'https://aleczas.pl/zapisy'
const SOURCE_URL = 'https://aleczas.pl/zapisy'
const USER_AGENT = 'leszy.run/1.0 (kontakt@leszy.run)'

// DD.MM.YYYY or D.MM.YYYY → YYYY-MM-DD
function parseDate(raw) {
  if (!raw) return null
  const m = raw.match(/^(\d{1,2})\.(\d{2})\.(\d{4})$/)
  if (!m) return null
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

function toSlug(str) {
  return str
    .toLowerCase()
    // Polish letters that don't decompose with NFD
    .replace(/ą/g, 'a').replace(/ć/g, 'c').replace(/ę/g, 'e')
    .replace(/ł/g, 'l').replace(/ń/g, 'n').replace(/ó/g, 'o')
    .replace(/ś/g, 's').replace(/ź/g, 'z').replace(/ż/g, 'z')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

function detectEventTypes(name) {
  const blob = (name || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|leśn[aey]|\btrail\b|cross(?:owy|owa|owe)?\b|przełaj/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b/i.test(blob)) tags.add('ocr')
  return [...tags]
}

// Check both name and distances content for kids signals.
// \b doesn't handle Polish letters — use manual non-letter boundary.
function hasKidsSignal(name, content) {
  const blob = ` ${(name + ' ' + (content || '')).toLowerCase()} `
  const NB = '[^a-ząćęłńóśźż]'
  if (/(?:biegi|dla)\s+dzieci/.test(blob)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(blob)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(blob)) return true
  if (new RegExp(`${NB}świetlik`).test(blob)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(blob)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(blob)) return true
  return false
}

// Clean distances text: strip activity-type prefixes (bieg, nw) and noise phrases,
// normalize spacing around km/m. Returns null if only non-distance content remains.
// Input example: "bieg 8km, nw 6km, biegi dla dzieci" → "8 km, 6 km"
function cleanDistances(raw) {
  if (!raw) return null
  let s = raw
    // Remove noise phrases first so they don't leave orphaned commas
    .replace(/biegi dla dzieci i m[lł]odzie[żz]y?/gi, '')
    .replace(/biegi dla dzieci/gi, '')
    .replace(/biegi dla m[lł]odzie[żz]y?/gi, '')
    .replace(/rolki/gi, '')
    // Strip activity-type prefixes before distances: "bieg 8km" → "8km", "nw 5km" → "5km"
    .replace(/\bnw\s+(?=\d)/gi, '')
    .replace(/\bbieg\s+(?=\d)/gi, '')
    // Normalize "Xkm" → "X km", "Xm" (meter distances ≥ 2 digits) → "X m"
    .replace(/(\d+)\s*km\b/gi, (_, n) => `${n} km`)
    .replace(/(\d{2,})\s*m\b/g, (_, n) => `${n} m`)
    .trim()
    .replace(/^[,\s]+|[,\s]+$/g, '')
    // Collapse multiple commas/spaces left by removals
    .replace(/,\s*,+/g, ',')
    .trim()
  return s || null
}

async function scrape({ knownIds = new Set() } = {}) {
  let html
  try {
    const res = await fetch(LIST_URL, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) throw new Error(`listing ${res.status} ${res.statusText}`)
    html = await res.text()
  } catch (err) {
    console.error('[aleczas] Listing fetch failed:', err.message)
    return []
  }

  const $ = cheerio.load(html)
  const results = []

  $('div.studies-entry').each((_, el) => {
    const entry = $(el)

    // Name: h6 inside .entry-content, may contain <br> tags.
    // Replace <br> with a space node so cheerio's .text() decodes entities correctly.
    const h6 = entry.find('.entry-content h6')
    h6.find('br').replaceWith(' ')
    const name = h6.text().replace(/\s+/g, ' ').trim()
    if (!name) return

    // Paragraphs inside .entry-content: first = distances, second = date + city (class mt-1)
    const paras = entry.find('.entry-content p')
    const distancesRaw = paras.not('.mt-1').first().text().trim() || null
    const dateCityRaw = paras.filter('.mt-1').first().text().trim() || ''

    // Parse "D.MM.YYYY, City" or "DD.MM.YYYY, City"
    const dcMatch = dateCityRaw.match(/^(\d{1,2}\.\d{2}\.\d{4}),\s*(.+)$/)
    const date = dcMatch ? parseDate(dcMatch[1]) : null
    const location = dcMatch ? dcMatch[2].trim() : null
    if (!date) return

    // Skip cycling events
    if (distancesRaw && /rower/i.test(distancesRaw)) return

    // Registration URL: first button link ("zapisz się")
    const regLink = entry.find('.entry-bottom a.button').first()
    const registration_url = regLink.attr('href')?.trim() || null

    const distances = cleanDistances(distancesRaw)
    // detectEventTypes checks the name; also pass raw distances to catch "nw Xkm" patterns
    const eventTypes = detectEventTypes(`${name} ${distancesRaw || ''}`)
    const isKids = hasKidsSignal(name, distancesRaw)

    const sourceId = `${toSlug(name)}-${date}`

    results.push({
      name,
      date,
      location,
      distances,
      registration_url,
      regulamin_url: null,
      website: null,
      is_kids: isKids,
      event_types: eventTypes.length ? eventTypes : null,
      price_from: null,
      price_to: null,
      registration_deadline: null,
      source: 'aleczas',
      source_id: sourceId,
      source_url: SOURCE_URL,
    })
  })

  console.log(`[aleczas] Scraped ${results.length} events`)
  return results
}

export { scrape, parseDate, detectEventTypes, hasKidsSignal }
