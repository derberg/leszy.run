import * as cheerio from 'cheerio'

const BASE_URL = 'https://zapisy.raatiming.pl'

// Polish month names (genitive) for date parsing from event names
const POLISH_MONTHS = {
  stycznia: '01', lutego: '02', marca: '03', kwietnia: '04',
  maja: '05', czerwca: '06', lipca: '07', sierpnia: '08',
  wrzesnia: '09', września: '09', pazdziernika: '10', października: '10',
  listopada: '11', grudnia: '12',
}

/**
 * Parse date from event name text. Handles multiple formats:
 *   "26.04.2026"       → 2026-04-26
 *   "3/05/2026"        → 2026-05-03
 *   "13 czerwca 2026"  → 2026-06-13
 *   "05.09.2026"       → 2026-09-05
 *   "12-07-2026"       → 2026-07-12
 */
function parseDateFromName(text) {
  if (!text) return null

  // DD.MM.YYYY or D.MM.YYYY
  const dotMatch = text.match(/(\d{1,2})\.(\d{2})\.(\d{4})/)
  if (dotMatch) {
    return `${dotMatch[3]}-${dotMatch[2]}-${dotMatch[1].padStart(2, '0')}`
  }

  // D/MM/YYYY or DD/MM/YYYY
  const slashMatch = text.match(/(\d{1,2})\/(\d{2})\/(\d{4})/)
  if (slashMatch) {
    return `${slashMatch[3]}-${slashMatch[2]}-${slashMatch[1].padStart(2, '0')}`
  }

  // DD-MM-YYYY
  const dashMatch = text.match(/(\d{1,2})-(\d{2})-(\d{4})/)
  if (dashMatch) {
    return `${dashMatch[3]}-${dashMatch[2]}-${dashMatch[1].padStart(2, '0')}`
  }

  // "13 czerwca 2026" — D month_name YYYY
  const wordMatch = text.match(/(\d{1,2})\s+([a-ząćęłńóśźż]+)\s+(\d{4})/i)
  if (wordMatch) {
    const month = POLISH_MONTHS[wordMatch[2].toLowerCase()]
    if (month) {
      return `${wordMatch[3]}-${month}-${wordMatch[1].padStart(2, '0')}`
    }
  }

  return null
}

/**
 * Strip the date portion from event name to get clean name.
 * e.g. "Zamczyska Trail 26.04.2026" → "Zamczyska Trail"
 */
function stripDateFromName(text) {
  return text
    .replace(/\d{1,2}[./-]\d{2}[./-]\d{4}/, '')
    .replace(/\d{1,2}\s+[a-ząćęłńóśźż]+\s+\d{4}/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract slug from event detail URL.
 * "/rejestracja-zamczyskatrail/" → "zamczyskatrail"
 */
function extractSlug(href) {
  const match = href.match(/\/rejestracja-([^/]+)\/?/)
  return match ? match[1] : null
}

// Domains that are NOT event websites
const SKIP_DOMAINS = /raatiming\.pl|tpay\.com|facebook\.com|fb\.com|youtube\.com|instagram\.com|twitter\.com|google\.|tiktok\.com/i

/**
 * Fetch a registration form page (level 3) and extract the event website/regulamin link.
 * These pages have a link with text like "Strona zawodów i regulamin" or
 * "Strona biegu i regulamin" pointing to the event's external site.
 */
async function fetchFormDetails(formUrl) {
  try {
    const res = await fetch(formUrl, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) return null

    const html = await res.text()
    const $ = cheerio.load(html)

    let website = null
    let regulaminUrl = null

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || ''
      const text = $(el).text().trim().toLowerCase()

      if (!href.startsWith('http')) return

      // "Strona zawodów i regulamin", "Strona biegu i regulamin", etc.
      if (text.includes('regulamin') || text.includes('strona zawod') || text.includes('strona bieg')) {
        // Website: exclude social, payment, and google.* (Docs/Drive are not event websites)
        if (!SKIP_DOMAINS.test(href)) {
          website = href
        }
        // Regulamin: Google Docs / Drive are valid regulamin hosts — only exclude
        // raatiming.pl itself (that's the registration form URL, not a regulamin doc)
        if (text.includes('regulamin') && !regulaminUrl && !href.includes('raatiming.pl')) {
          regulaminUrl = href
        }
      }
    })

    return { website, regulamin_url: regulaminUrl }
  } catch (err) {
    console.warn(`  [raatiming] Error fetching form ${formUrl}: ${err.message}`)
    return null
  }
}

/**
 * Fetch event detail page (level 2) and extract distances from category cards.
 * Each card text is like "Dycha na Zamczyska 10km", "Nordic Walking 5km".
 * Registration form links are absolute URLs containing the event slug, e.g.
 *   https://zapisy.raatiming.pl/zamczyskatrail-dycha-10km.html
 *
 * Then fetches the first registration form page (level 3) for regulamin/website.
 */
async function fetchEventDetails(eventUrl, slug) {
  try {
    const res = await fetch(eventUrl, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) return null

    const html = await res.text()
    const $ = cheerio.load(html)

    const distances = new Set()
    const registrationUrls = []

    // Only match links whose href contains the event slug — filters out nav links
    // like polityka.html, regulamin.html, kontakt.html
    $('a[href$=".html"]').each((_, el) => {
      const href = $(el).attr('href') || ''
      if (!href.includes(slug)) return

      const text = $(el).text().trim()
      if (!text) return

      // Extract distance from card text: "10km", "21km", "5 km", "800m"
      const kmMatches = text.matchAll(/(\d+(?:[.,]\d+)?)\s*(km|m)\b/gi)
      for (const m of kmMatches) {
        const num = m[1].replace(',', '.')
        const unit = m[2].toLowerCase()
        if (unit === 'm' && parseFloat(num) > 1000) continue
        distances.add(`${num} ${unit}`)
      }

      // Collect registration form URLs
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`
      registrationUrls.push(fullUrl)
    })

    // Fetch first registration form page for regulamin/website
    let website = null
    let regulaminUrl = null
    if (registrationUrls.length > 0) {
      await new Promise(r => setTimeout(r, 300))
      const formDetails = await fetchFormDetails(registrationUrls[0])
      if (formDetails) {
        website = formDetails.website
        regulaminUrl = formDetails.regulamin_url
      }
    }

    return {
      distances: [...distances].join(', ') || null,
      registrationUrls,
      website,
      regulamin_url: regulaminUrl,
    }
  } catch (err) {
    console.warn(`  [raatiming] Error fetching ${eventUrl}: ${err.message}`)
    return null
  }
}

/**
 * Scrape zapisy.raatiming.pl — small timing company registration portal.
 * Static HTML, no pagination, ~7-15 events at a time.
 */
export async function scrape({ knownIds = new Set() } = {}) {
  const today = new Date().toISOString().split('T')[0]
  const results = []

  try {
    const res = await fetch(BASE_URL, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) {
      console.error(`[raatiming] Main page returned ${res.status}`)
      return results
    }

    const html = await res.text()
    const $ = cheerio.load(html)

    // Event cards are <li> items inside portfolio list, each with an <a> wrapping an image + text
    const entries = []

    $('li a[href*="rejestracja-"]').each((_, el) => {
      const href = $(el).attr('href') || ''
      const text = $(el).text().trim()

      // Skip reservation placeholders
      if (/rezerwacja\s+terminu/i.test(text)) return

      const slug = extractSlug(href)
      if (!slug) return

      const date = parseDateFromName(text)
      if (!date) return
      if (date < today) return

      const name = stripDateFromName(text)
      if (!name || name.length < 3) return

      const eventUrl = href.startsWith('http') ? href : `${BASE_URL}/rejestracja-${slug}/`

      entries.push({ name, date, slug, eventUrl })
    })

    // Dedup by slug
    const seen = new Set()
    const unique = entries.filter(e => {
      if (seen.has(e.slug)) return false
      seen.add(e.slug)
      return true
    })

    console.log(`[raatiming] Found ${unique.length} events on listing page`)

    // Filter out already-known events
    const fresh = unique.filter(e => !knownIds.has(e.slug))
    console.log(`[raatiming] ${fresh.length} new events to process`)

    // Fetch detail pages for distances
    for (const entry of fresh) {
      const detail = await fetchEventDetails(entry.eventUrl, entry.slug)

      results.push({
        name: entry.name,
        date: entry.date,
        distances: detail?.distances || null,
        registration_url: detail?.registrationUrls?.[0] || entry.eventUrl,
        website: detail?.website || null,
        regulamin_url: detail?.regulamin_url || null,
        source: 'raatiming',
        source_id: entry.slug,
        source_url: entry.eventUrl,
      })

      // Rate limit
      await new Promise(r => setTimeout(r, 500))
    }

    console.log(`[raatiming] Scraped ${results.length} new events`)
  } catch (err) {
    console.error(`[raatiming] Scrape failed: ${err.message}`)
  }

  return results
}
