// inesSport — Łódź-area timing company, zapisy.inessport.pl
// Data source: single HTML listing page at /index.php?idm=5
// All fields from listing — no detail page fetches needed.
// Two event shapes: standalone (ev####) and grouped with sub-items (gr####).
// Dates from Polish month spans; registration from ?act=zgloszenie-zawodnika&event=####.
// Distances extracted from umbrella + sub-item names (km regex + Polish nicknames).
// Prices not exposed in HTML (loaded dynamically) — left to Python enricher.
// Cycling events (gravel, MTB) skipped.
// URL verification: registration URL confirmed via curl -sIL for event 1351 (200, event-specific content).

import * as cheerio from 'cheerio'

const BASE_URL = 'https://zapisy.inessport.pl'
const LISTING_URL = `${BASE_URL}/index.php?idm=5`

const POLISH_MONTHS = {
  'styczeń': '01', 'luty': '02', 'marzec': '03', 'kwiecień': '04',
  'maj': '05', 'czerwiec': '06', 'lipiec': '07', 'sierpień': '08',
  'wrzesień': '09', 'październik': '10', 'listopad': '11', 'grudzień': '12',
}

function parseDate(day, month, year) {
  const mm = POLISH_MONTHS[(month || '').toLowerCase()]
  if (!mm || !day || !year) return null
  return `${year}-${mm}-${String(day).padStart(2, '0')}`
}

const SKIP_CYCLING = /\bgravel\b|\bmtb\b|\bkolarsk|\brower/i

function detectEventTypes(name) {
  const blob = (name || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|le[sś]n[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.add('trail')
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

function findRegulaminUrl($, el) {
  let url = null
  $(el).find('a[target="_blank"]').each((_, a) => {
    if (url) return
    if (/regulamin/i.test($(a).text())) url = $(a).attr('href') || null
  })
  return url
}

function findWebsiteUrl($, el) {
  let url = null
  $(el).find('a[target="_blank"]').each((_, a) => {
    if (url) return
    if (/strona\s+www/i.test($(a).text())) url = $(a).attr('href') || null
  })
  return url
}

function resolveHref(href) {
  if (!href) return null
  return href.startsWith('http') ? href : `${BASE_URL}${href}`
}

// Extract distances from umbrella name + sub-item names.
// Catches explicit "5 km", "10 km" patterns and Polish distance nicknames.
// Sub-item names like "- 10 km" and "- 3 km" (seen on XIII Dycha Anny Wazówny) contribute too.
function extractDistances(umbrella, subItemNames) {
  const allNames = [umbrella, ...(subItemNames || [])].filter(Boolean)
  const candidates = new Map() // rounded_tenth_km → display string

  for (const n of allNames) {
    const s = ` ${n} `

    // Explicit "N km" / "N,N km" patterns (case-insensitive)
    const re = /(\d+[.,]?\d*)\s*km/gi
    let m
    while ((m = re.exec(s)) !== null) {
      const val = parseFloat(m[1].replace(',', '.'))
      if (val >= 1 && val <= 250) {
        const key = Math.round(val * 10)
        if (!candidates.has(key)) {
          candidates.set(key, Number.isInteger(val) ? `${val} km` : `${m[1]} km`)
        }
      }
    }

    // Polish distance nicknames — matched case-insensitively, non-letter boundary
    const add = (key, display) => { if (!candidates.has(key)) candidates.set(key, display) }
    const sl = s.toLowerCase()
    if (/półmaraton/.test(sl)) add(211, '21,1 km')
    if (/ćwierćmaraton/.test(sl)) add(105, '10,5 km')
    // "maraton" but not as suffix of "półmaraton"/"ultramaraton"/"ćwierćmaraton"
    if (/[^a-ząćęłńóśźż]maraton/.test(sl) && !/półmaraton|ćwierćmaraton/.test(sl)) add(422, '42,2 km')
    if (/[^a-ząćęłńóśźż]dycha[^a-ząćęłńóśźż]|[^a-ząćęłńóśźż]dyszka[^a-ząćęłńóśźż]/.test(sl)) add(100, '10 km')
    if (/[^a-ząćęłńóśźż]dziesiątka[^a-ząćęłńóśźż]/.test(sl)) add(100, '10 km')
    if (/[^a-ząćęłńóśźż]piątka[^a-ząćęłńóśźż]/.test(sl)) add(50, '5 km')
    if (/[^a-ząćęłńóśźż]trójka[^a-ząćęłńóśźż]/.test(sl)) add(30, '3 km')
    if (/[^a-ząćęłńóśźż]piętnastka[^a-ząćęłńóśźż]/.test(sl)) add(150, '15 km')
  }

  if (candidates.size === 0) return null
  return [...candidates.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(e => e[1])
    .join(', ')
}

export async function scrape({ knownIds = new Set() } = {}) {
  const today = new Date().toISOString().split('T')[0]
  const results = []

  try {
    const res = await fetch(LISTING_URL, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) {
      console.error(`[inessport] Listing returned ${res.status}`)
      return results
    }

    const html = await res.text()
    const $ = cheerio.load(html)

    $('.event-list > .event-item-main').each((_, el) => {
      const $el = $(el)
      const anchor = $el.prev('.anchor')
      const id = anchor.attr('id')
      if (!id) return

      const isGroup = $el.find('.event-subitem-main').length > 0

      let name, date, location, registrationUrl, regulaminUrl, website, isKids, distances
      const subItemNames = []

      if (isGroup) {
        const day = $el.find('.event-date .day').first().text().trim()
        const month = $el.find('.event-date .month').first().text().trim()
        const year = $el.find('.event-date .year').first().text().trim()
        date = parseDate(day, month, year)

        // Umbrella name is in the top-level .event-header (not sub-item headers)
        name = $el.children('.event-header').find('h1.event-title').text().trim()
        if (!name) name = $el.find('.event-header').first().find('h1.event-title').text().trim()

        const $headerClone = $el.children('.event-header').first().clone()
        $headerClone.find('h1').remove()
        location = $headerClone.text().trim() || null

        // Collect sub-item names for distance extraction and kids detection
        $el.find('.event-subitem-main').each((_, sub) => {
          subItemNames.push($(sub).find('.event-title').text().trim())
        })

        isKids = subItemNames.some(hasKidsSignal)

        // Registration: first non-kids sub-item with Formularz
        $el.find('.event-subitem-main').each((_, sub) => {
          if (registrationUrl) return
          const subName = $(sub).find('.event-title').text()
          if (hasKidsSignal(subName)) return
          const btn = $(sub).find('a[href*="zgloszenie-zawodnika"]').first()
          if (btn.length) registrationUrl = resolveHref(btn.attr('href'))
        })
        // Fallback: any sub-item
        if (!registrationUrl) {
          const btn = $el.find('a[href*="zgloszenie-zawodnika"]').first()
          if (btn.length) registrationUrl = resolveHref(btn.attr('href'))
        }

        // Regulamin + website: from first sub-item (usually shared across all sub-items)
        const $firstSub = $el.find('.event-subitem-main').first()
        regulaminUrl = findRegulaminUrl($, $firstSub)
        website = findWebsiteUrl($, $firstSub)

      } else {
        const day = $el.find('.event-date .day').text().trim()
        const month = $el.find('.event-date .month').text().trim()
        const year = $el.find('.event-date .year').text().trim()
        date = parseDate(day, month, year)

        name = $el.find('h1.event-h1').text().trim()

        const $nameClone = $el.find('.event-name').first().clone()
        $nameClone.find('h1').remove()
        location = $nameClone.text().trim() || null

        isKids = hasKidsSignal(name)

        const btn = $el.find('a[href*="zgloszenie-zawodnika"]').first()
        if (btn.length) registrationUrl = resolveHref(btn.attr('href'))

        regulaminUrl = findRegulaminUrl($, el)
        website = findWebsiteUrl($, el)
      }

      if (!name || !date) return
      if (date < today) return
      if (SKIP_CYCLING.test(name)) {
        console.log(`[inessport] Skipping cycling: ${name}`)
        return
      }

      distances = extractDistances(name, subItemNames)

      results.push({
        name,
        date,
        location: location || null,
        distances,
        registration_url: registrationUrl || null,
        regulamin_url: regulaminUrl || null,
        website: website || null,
        is_kids: isKids || false,
        event_types: detectEventTypes(name),
        source: 'inessport',
        source_id: id,
        source_url: `${LISTING_URL}#${id}`,
      })
    })

    console.log(`[inessport] Scraped ${results.length} future events`)
  } catch (err) {
    console.error(`[inessport] Scrape failed: ${err.message}`)
  }

  return results
}
