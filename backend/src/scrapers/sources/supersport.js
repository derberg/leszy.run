import * as cheerio from 'cheerio'

const BASE_URL = 'https://super-sport.com.pl'
const LIST_URL = `${BASE_URL}/zapisy-formularze.html`

/**
 * Parse a detail page to extract event data.
 * The detail page has a <table> with rows like:
 *   <td>Label:</td> <td>Value</td>
 */
async function fetchDetailPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) return null

    const html = await res.text()
    const $ = cheerio.load(html)

    const fields = {}

    // The info table is inside .item-page, with rows containing label:value pairs
    // Structure: <tr><td></td><td>Label:</td><td>Value</td></tr>
    $('table td').each((_, el) => {
      const text = $(el).text().trim()
      if (!text.endsWith(':')) return

      const label = text.replace(/:$/, '').trim()
      const valueTd = $(el).next('td')
      if (!valueTd.length) return

      const value = valueTd.text().trim()
      const link = valueTd.find('a').attr('href') || null

      fields[label] = { value, link }
    })

    // Parse date: "DD.MM.YYYY HH:MM" → "YYYY-MM-DD"
    let date = null
    const dateRaw = fields['Data i godzina']?.value
    if (dateRaw) {
      const match = dateRaw.match(/(\d{2})\.(\d{2})\.(\d{4})/)
      if (match) date = `${match[3]}-${match[2]}-${match[1]}`
    }

    // Distance: "5km", "10km", "12km", "21,1km" etc.
    let distances = null
    const distRaw = fields['Dystans']?.value
    if (distRaw && distRaw !== '-') {
      const parts = distRaw.split(/[,;/]/).map(s => s.trim()).filter(Boolean)
      const parsed = parts.map(d => {
        const m = d.match(/(\d+[.,]?\d*)\s*km/i)
        if (m) return `${m[1].replace(',', '.')} km`
        const h = d.match(/(\d+)\s*[hH]/)
        if (h) return `${h[1]}h`
        return null
      }).filter(Boolean)
      if (parsed.length) distances = parsed.join(', ')
    }
    // Fallback: try extracting distance/duration from event name
    if (!distances) {
      const title = $('h1').first().text().trim() || ''
      const hMatch = title.match(/(\d+)\s*[hH]/)
      if (hMatch) distances = `${hMatch[1]}h`
      const kmMatch = title.match(/(\d+[.,]?\d*)\s*km/i)
      if (kmMatch) distances = `${kmMatch[1].replace(',', '.')} km`
    }

    // Price: "80 PLN", "Od 60 PLN", "od 65 PLN"
    let priceFrom = null
    const priceRaw = fields['Opłata wpisowa']?.value
    if (priceRaw) {
      const m = priceRaw.match(/(\d+)\s*PLN/i)
      if (m) priceFrom = m[1]
    }

    // Max participants: "1000 osób", "300 zawodników", "250 osób"
    let maxParticipants = null
    const limitRaw = fields['Limit zgłoszeń']?.value
    if (limitRaw) {
      const m = limitRaw.match(/(\d+)/)
      if (m) maxParticipants = m[1]
    }

    // Regulamin link
    let regulaminUrl = fields['Regulamin biegu']?.link || null
    if (regulaminUrl && regulaminUrl.startsWith('/')) {
      regulaminUrl = `${BASE_URL}${regulaminUrl}`
    }

    // Organizer website
    let website = fields['Strona Organizatora']?.link || null
    if (website && website.startsWith('/')) {
      website = `${BASE_URL}${website}`
    }

    // Event type from "Typ zawodów"
    const typRaw = fields['Typ zawodów']?.value || ''

    // Detect kids events from name
    const title = $('h1').first().text().trim() || ''
    const isKids = /dzieci|młodzież/i.test(title)

    return {
      date,
      location: fields['Miejscowość']?.value || null,
      distances,
      price_from: priceFrom,
      max_participants: maxParticipants,
      regulamin_url: regulaminUrl,
      website,
      event_type: typRaw,
      is_kids: isKids,
    }
  } catch (err) {
    console.warn(`  [supersport] Error fetching ${url}: ${err.message}`)
    return null
  }
}

/**
 * Scrape super-sport.com.pl event list + detail pages.
 * @param {{ knownIds?: Set<string> }} options
 * @returns {Array<Object>}
 */
export async function scrape({ knownIds = new Set() } = {}) {
  const results = []

  try {
    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) {
      console.error(`[supersport] List page returned ${res.status}`)
      return results
    }

    const html = await res.text()
    const $ = cheerio.load(html)

    // Event links are in <a href="/zapisy-formularze/{id}-{slug}.html">
    const entries = []
    $('a[href*="/zapisy-formularze/"]').each((_, el) => {
      const href = $(el).attr('href')
      if (!href || href === '/zapisy-formularze.html') return

      // Extract source_id from URL: /zapisy-formularze/4599-slug.html → "4599"
      const idMatch = href.match(/\/zapisy-formularze\/(\d+)-/)
      if (!idMatch) return

      const sourceId = idMatch[1]
      const name = $(el).text().trim()
      if (!name) return

      entries.push({ sourceId, name, href })
    })

    // Dedup by sourceId (list might have duplicate links)
    const seen = new Set()
    const unique = entries.filter(e => {
      if (seen.has(e.sourceId)) return false
      seen.add(e.sourceId)
      return true
    })

    console.log(`[supersport] Found ${unique.length} events on list page`)

    for (const entry of unique) {
      if (knownIds.has(entry.sourceId)) continue

      const detailUrl = entry.href.startsWith('http')
        ? entry.href
        : `${BASE_URL}${entry.href}`

      const detail = await fetchDetailPage(detailUrl)

      if (!detail || !detail.date) {
        console.warn(`  [supersport] Skipping ${entry.name} — no date found`)
        continue
      }

      results.push({
        name: entry.name,
        date: detail.date,
        location: detail.location,
        distances: detail.distances,
        registration_url: detailUrl,
        regulamin_url: detail.regulamin_url,
        website: detail.website,
        price_from: detail.price_from,
        max_participants: detail.max_participants,
        is_kids: detail.is_kids,
        source: 'supersport',
        source_id: entry.sourceId,
        source_url: detailUrl,
      })
    }

    console.log(`[supersport] Scraped ${results.length} new events`)
  } catch (err) {
    console.error(`[supersport] Scrape failed: ${err.message}`)
  }

  return results
}
