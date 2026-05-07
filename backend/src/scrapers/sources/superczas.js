import * as cheerio from 'cheerio'

const LISTING_URL = 'https://superczas.pl/zapisy'
const BASE_URL = 'https://superczas.pl'
const USER_AGENT = 'leszy.run/1.0 (kontakt@leszy.run)'

const POLISH_MONTHS = {
  stycznia: 1, lutego: 2, marca: 3, kwietnia: 4, maja: 5, czerwca: 6,
  lipca: 7, sierpnia: 8, września: 9, października: 10, listopada: 11, grudnia: 12,
}

function parsePolishDate(text) {
  if (!text) return null
  const m = text.match(/(\d{1,2})\s+(\p{L}+)\s+(\d{4})/u)
  if (!m) return null
  const day = parseInt(m[1], 10)
  const month = POLISH_MONTHS[m[2].toLowerCase()]
  const year = parseInt(m[3], 10)
  if (!month) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseSlugFromUrl(url) {
  if (!url) return null
  const m = url.match(/superczas\.pl\/([a-z0-9_-]+?)(?:#|\/|$)/i)
  return m ? m[1] : null
}

function detectEventTypes(name) {
  const haystack = (name || '').toLowerCase()
  const tags = new Set()
  if (/trail\s*runn?ing|\btrail\b/i.test(haystack)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b/i.test(haystack)) tags.add('nordic walking')
  if (/\bnocny\b|\bnocna\b|\bnocne\b/i.test(haystack)) tags.add('nocny')
  if (/\bultra(?:maraton)?\b/i.test(haystack)) tags.add('ultra')
  if (/\buliczn[aey]\b/i.test(haystack)) tags.add('uliczny')
  if (/charytatyw/i.test(haystack)) tags.add('charytatywny')
  return tags.size > 0 ? [...tags] : null
}

// Detect kids events from h3 heading text on the detail page or distance values
function detectIsKids(name, h3Texts, distancesNum) {
  const blob = `${name || ''} ${h3Texts.join(' ')}`.toLowerCase()
  if (/dla\s+dzieci|biegi\s+dzieci|rodzinny|m[lł]odzie[zż]y|świetlik/i.test(blob)) return true
  // Pure short-distance event with no adult-distance category
  if (distancesNum.length > 0 && distancesNum.every(d => d <= 1)) return true
  return false
}

async function fetchListing() {
  const res = await fetch(LISTING_URL, {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!res.ok) throw new Error(`listing ${res.status} ${res.statusText}`)
  return res.text()
}

async function fetchDetail(slug) {
  const url = `${BASE_URL}/${slug}`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) return { distances: null, regulaminUrl: null, isKids: false, h3Texts: [] }
    const html = await res.text()
    const $ = cheerio.load(html)

    const h3Texts = []
    const distancesNum = []
    $('h3').each((_, el) => {
      const text = $(el).text().trim()
      if (!text) return
      // Skip "Partnerzy Superczas.pl" footer heading
      if (/Partnerzy/i.test(text)) return
      h3Texts.push(text)
      const m = text.match(/dystans\s+([\d.,]+)\s*km/i)
      if (m) {
        const num = parseFloat(m[1].replace(',', '.'))
        if (Number.isFinite(num)) distancesNum.push(num)
      }
    })

    // Format distances as "5 km, 10 km, 21.098 km"
    const distances = distancesNum.length > 0
      ? distancesNum.map(d => `${d} km`).join(', ')
      : null

    // Find the first regulamin PDF on the page
    let regulaminUrl = null
    $('a[href*="userfiles/events/"]').each((_, el) => {
      if (regulaminUrl) return
      const href = $(el).attr('href') || ''
      if (/\.pdf(\?|$)/i.test(href)) {
        regulaminUrl = href.startsWith('http')
          ? href.split('?')[0]
          : new URL(href.split('?')[0], BASE_URL).toString()
      }
    })

    return { distances, regulaminUrl, distancesNum, h3Texts }
  } catch {
    return { distances: null, regulaminUrl: null, distancesNum: [], h3Texts: [] }
  }
}

async function scrape({ knownIds = new Set() } = {}) {
  let html
  try {
    html = await fetchListing()
  } catch (err) {
    console.error('[superczas] Listing fetch failed:', err.message)
    return []
  }

  const $ = cheerio.load(html)
  const rows = []

  $('table.events tr').each((_, tr) => {
    const $tr = $(tr)
    const titleAnchor = $tr.find('td.show_more a').first()
    const href = titleAnchor.attr('href')
    const rawName = titleAnchor.text().trim().replace(/\s+/g, ' ')
    if (!href || !rawName) return

    const slug = parseSlugFromUrl(href)
    if (!slug) return

    const cells = $tr.find('td')
    // Cell layout: [#, date, show_more (name), location, deadline, count, button]
    const dateText = $(cells[1]).text().trim()
    const date = parsePolishDate(dateText)
    if (!date) return

    const location = $(cells[3]).text().trim().replace(/\s+/g, ' ') || null
    const deadlineText = $(cells[4]).text().trim()
    const registrationDeadline = parsePolishDate(deadlineText)

    rows.push({
      slug,
      name: rawName,
      date,
      location,
      registrationDeadline,
    })
  })

  console.log(`[superczas] Phase 1: parsed ${rows.length} listing rows`)

  const events = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const isKnown = knownIds.has(r.slug)

    let detail = { distances: null, regulaminUrl: null, distancesNum: [], h3Texts: [] }
    if (!isKnown) {
      detail = await fetchDetail(r.slug)
      if (i < rows.length - 1) await new Promise(res => setTimeout(res, 1100))
    }

    const eventTypes = detectEventTypes(r.name)
    const isKids = detectIsKids(r.name, detail.h3Texts || [], detail.distancesNum || [])

    events.push({
      name: r.name,
      date: r.date,
      location: r.location,
      distances: detail.distances,
      registration_url: `${BASE_URL}/${r.slug}/zapisy`,
      registration_deadline: r.registrationDeadline,
      regulamin_url: detail.regulaminUrl,
      website: null,
      is_kids: isKids,
      event_types: eventTypes,
      source: 'superczas',
      source_id: r.slug,
      source_url: `${BASE_URL}/${r.slug}`,
    })
  }

  const newCount = events.filter(e => !knownIds.has(e.source_id)).length
  console.log(`[superczas] Scraped ${events.length} events (${newCount} new)`)
  return events
}

export { scrape, parsePolishDate, parseSlugFromUrl, detectEventTypes }
