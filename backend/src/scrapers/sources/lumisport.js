import * as cheerio from 'cheerio'

const STORE_API_URL = 'https://lumisport.eu/wp-json/wc/store/v1/products?per_page=100'
const USER_AGENT = 'leszy.run/1.0 (kontakt@leszy.run)'

const POLISH_MONTHS = {
  stycznia: 1, lutego: 2, marca: 3, kwietnia: 4, maja: 5, czerwca: 6,
  lipca: 7, sierpnia: 8, września: 9, października: 10, listopada: 11, grudnia: 12,
}

function stripHtml(s) {
  if (!s) return ''
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-zA-Z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function inferYear(month, day, today = new Date()) {
  const today0 = new Date(today)
  today0.setHours(0, 0, 0, 0)
  const candidate = new Date(today0.getFullYear(), month - 1, day)
  candidate.setHours(0, 0, 0, 0)
  return candidate >= today0 ? today0.getFullYear() : today0.getFullYear() + 1
}

function parseDate(text) {
  const numeric = text.match(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/)
  if (numeric) {
    const dd = numeric[1].padStart(2, '0')
    const mm = numeric[2].padStart(2, '0')
    const yyyy = numeric[3]
    return `${yyyy}-${mm}-${dd}`
  }

  const polishRe = new RegExp(
    `\\b(\\d{1,2})\\s+(${Object.keys(POLISH_MONTHS).join('|')})(?:\\s+(\\d{4}))?\\b`,
    'i'
  )
  const polish = text.match(polishRe)
  if (polish) {
    const day = parseInt(polish[1], 10)
    const month = POLISH_MONTHS[polish[2].toLowerCase()]
    const year = polish[3] ? parseInt(polish[3], 10) : inferYear(month, day)
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  return null
}

function parseDistances(attributes) {
  if (!Array.isArray(attributes)) return { distances: null, isKids: false }
  const dystans = attributes.find(a => a.taxonomy === 'pa_dystans')
  if (!dystans || !Array.isArray(dystans.terms)) return { distances: null, isKids: false }

  let isKids = false
  const distances = []
  for (const term of dystans.terms) {
    const name = (term.name || '').trim()
    if (!name) continue
    if (/dzieci/i.test(name)) {
      isKids = true
      continue
    }
    distances.push(name)
  }
  return {
    distances: distances.length ? distances.join(', ') : null,
    isKids,
  }
}

function parsePrices(prices) {
  if (!prices) return { priceFrom: null, priceTo: null }
  const range = prices.price_range
  const min = range?.min_amount ?? prices.price ?? null
  const max = range?.max_amount ?? prices.price ?? null
  const toPLN = v => {
    if (v === null || v === undefined) return null
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return null
    return n / 100
  }
  return { priceFrom: toPLN(min), priceTo: toPLN(max) }
}

async function fetchProducts() {
  const res = await fetch(STORE_API_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`store API ${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function fetchRegulaminUrl(permalink) {
  try {
    const res = await fetch(permalink, {
      headers: { 'User-Agent': USER_AGENT },
    })
    if (!res.ok) return null
    const html = await res.text()
    const $ = cheerio.load(html)
    let pdf = null
    $('a[href$=".pdf"]').each((_, el) => {
      if (pdf) return
      const href = $(el).attr('href')
      if (href) pdf = href.startsWith('http') ? href : new URL(href, permalink).toString()
    })
    return pdf
  } catch {
    return null
  }
}

async function scrape({ knownIds = new Set() } = {}) {
  const results = []

  let products
  try {
    products = await fetchProducts()
  } catch (err) {
    console.error('[lumisport] Store API fetch failed:', err.message)
    return results
  }

  if (!Array.isArray(products)) {
    console.error('[lumisport] Store API returned non-array, got:', typeof products)
    return results
  }

  let dropped = 0
  for (const product of products) {
    try {
      if (!product.is_purchasable) continue
      const isCompetition = Array.isArray(product.categories)
        && product.categories.some(c => c.slug === 'zawody')
      if (!isCompetition) continue

      const slug = product.slug
      if (!slug) continue

      const name = product.name?.trim()
      if (!name) continue

      const descText = stripHtml(`${product.short_description || ''} ${product.description || ''}`)
      const date = parseDate(descText)
      if (!date) {
        console.warn(`[lumisport] No parseable date for "${slug}" — dropping`)
        dropped++
        continue
      }

      const { distances, isKids } = parseDistances(product.attributes)
      const { priceFrom, priceTo } = parsePrices(product.prices)
      const permalink = product.permalink

      results.push({
        name,
        date,
        location: null,
        distances,
        registration_url: permalink,
        regulamin_url: null,
        website: permalink,
        is_kids: isKids,
        price_from: priceFrom,
        price_to: priceTo,
        source: 'lumisport',
        source_id: slug,
        source_url: permalink,
      })
    } catch (err) {
      console.error(`[lumisport] Failed to parse product ${product?.slug}:`, err.message)
    }
  }

  console.log(`[lumisport] Phase 1 done: ${results.length} datable events (dropped ${dropped} undated)`)

  for (let i = 0; i < results.length; i++) {
    const row = results[i]
    if (knownIds.has(row.source_id)) continue
    row.regulamin_url = await fetchRegulaminUrl(row.source_url)
    if (i < results.length - 1) await new Promise(r => setTimeout(r, 1100))
  }

  console.log(`[lumisport] Done with regulamin lookup`)
  return results
}

export { scrape, parseDate, parseDistances, parsePrices }
