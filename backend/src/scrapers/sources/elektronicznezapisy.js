import * as cheerio from 'cheerio'

const BASE_URL = 'https://elektronicznezapisy.pl'

const CATEGORY_URLS = [
  { url: `${BASE_URL}/1/bieg.html`, type: 'running' },
  { url: `${BASE_URL}/2/nordic-walking.html`, type: 'nordic' },
]

async function fetchDetailPage(eventId) {
  try {
    const url = `${BASE_URL}/event/${eventId}/strona.html`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    // Name from <h1>
    const name = $('h1').first().text().trim()

    // City: try multiple patterns
    let location = null

    // Pattern 1: <a href="/m/city">City</a>
    const cityLink = $('a[href^="/m/"]').first()
    if (cityLink.length) {
      location = cityLink.text().trim()
    }

    // Pattern 2: <li>Miejsce: <strong>City</strong></li>
    if (!location) {
      $('li, p, div').each((_, el) => {
        const text = $(el).text().trim()
        const match = text.match(/Miejsce:\s*(.+)/i)
        if (match && !location) {
          location = match[1].trim()
        }
      })
    }

    // Pattern 3: search for known city in <strong> tags
    if (!location) {
      $('strong').each((_, el) => {
        const text = $(el).text().trim()
        // City-like: short text, not a date, not a number
        if (text.length > 2 && text.length < 30 && !/\d{4}/.test(text) && !/^\d+$/.test(text) && !location) {
          const parent = $(el).parent().text().trim()
          if (parent.toLowerCase().includes('miejsce') || parent.toLowerCase().includes('lokalizacja')) {
            location = text
          }
        }
      })
    }

    // Date from text near "Początek imprezy" or any YYYY.MM.DD / YYYY-MM-DD pattern
    const allText = $('body').text()
    const dateMatch = allText.match(/(\d{4})[.\-](\d{2})[.\-](\d{2})/)
    const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null

    // Distances: look for "km" patterns in page text
    const distMatches = [...allText.matchAll(/(\d+[.,]?\d*)\s*km/gi)]
    const distances = distMatches.map(m => `${parseFloat(m[1].replace(',', '.'))} km`)

    // Store clean page text for LLM enrichment later
    const rawDescription = allText.replace(/\s+/g, ' ').trim().slice(0, 5000)

    return { name: name || null, location, date, distances: distances.join(', '), rawDescription }
  } catch (err) {
    console.error(`[elektronicznezapisy] Detail fetch failed for event ${eventId}:`, err.message)
    return null
  }
}

async function scrape() {
  // Step 1: collect event IDs + basic data from listing pages
  const eventEntries = []

  for (const category of CATEGORY_URLS) {
    try {
      const res = await fetch(category.url, {
        headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
      })
      const html = await res.text()
      const $ = cheerio.load(html)

      $('tr').each((_, el) => {
        const cells = $(el).find('td')
        if (cells.length < 4) return

        const nameCell = $(cells[1])
        const href = nameCell.find('a').first().attr('href')

        const dateText = $(cells[2]).text().trim()
        const dateMatch = dateText.match(/(\d{4}-\d{2}-\d{2})/)
        const date = dateMatch ? dateMatch[1] : null

        if (!href || !date) return

        const idMatch = href.match(/event\/(\d+)/)
        if (!idMatch) return

        const signupLink = $(el).find('a[href*="signup"]').attr('href')

        eventEntries.push({
          eventId: idMatch[1],
          date,
          signupLink,
          categoryUrl: category.url,
        })
      })
    } catch (err) {
      console.error(`[elektronicznezapisy] Listing scrape failed for ${category.url}:`, err.message)
    }
  }

  console.log(`[elektronicznezapisy] Found ${eventEntries.length} events in listings, fetching details...`)

  // Step 2: fetch detail pages for clean data
  const results = []

  for (const entry of eventEntries) {
    const detail = await fetchDetailPage(entry.eventId)

    if (detail && detail.name) {
      results.push({
        name: detail.name,
        date: detail.date || entry.date,
        location: detail.location || '',
        distances: detail.distances || '',
        description: detail.rawDescription || '',
        registration_url: entry.signupLink
          ? `${BASE_URL}/${entry.signupLink}`
          : `${BASE_URL}/event/${entry.eventId}/strona.html`,
        source: 'elektronicznezapisy',
        source_url: entry.categoryUrl,
        source_id: entry.eventId,
      })
    }

    // Rate limit: 1 req/sec
    await new Promise(r => setTimeout(r, 1100))
  }

  console.log(`[elektronicznezapisy] Scraped ${results.length} events with details`)
  return results
}

export { scrape }
