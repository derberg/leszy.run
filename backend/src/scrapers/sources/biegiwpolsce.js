import * as cheerio from 'cheerio'

const BASE_URL = 'https://www.biegiwpolsce.pl'

async function fetchDetailPage(path) {
  try {
    const url = `${BASE_URL}${path}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    // Detail page has <strong>City</strong>, voivodeship
    const strongTags = $('strong')
    let city = null
    let voivodeship = null

    strongTags.each((_, el) => {
      const text = $(el).text().trim()
      const after = $(el).parent().text().trim()
      // Pattern: "City, voivodeship" or "City , voivodeship"
      const match = after.match(new RegExp(`${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,\\s*([a-ząćęłńóśźż-]+)`, 'i'))
      if (match && text.length < 30 && !city) {
        city = text
        voivodeship = match[1].trim()
      }
    })

    // Extract distances from page text — look for categories like "Półmaraton", "10 km", etc.
    const pageText = $('body').text()
    const distances = []
    const kmMatches = [...pageText.matchAll(/(\d+[.,]?\d*)\s*km/gi)]
    for (const m of kmMatches) {
      const km = parseFloat(m[1].replace(',', '.'))
      if (km > 0 && km < 500 && !distances.includes(`${km} km`)) {
        distances.push(`${km} km`)
      }
    }
    // Named distances
    if (pageText.toLowerCase().includes('półmaraton') && !distances.some(d => d.includes('21'))) {
      distances.push('21.1 km')
    }

    // Store clean page text for LLM enrichment
    const rawDescription = pageText.replace(/\s+/g, ' ').trim().slice(0, 5000)

    return { city, voivodeship, distances: distances.join(', '), rawDescription }
  } catch (err) {
    return null
  }
}

async function scrape() {
  const results = []
  let page = 1
  const maxPages = 10

  // Step 1: collect events from listing pages
  const eventEntries = []

  while (page <= maxPages) {
    try {
      const url = page === 1 ? BASE_URL : `${BASE_URL}/?page=${page}`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
      })
      const html = await res.text()
      const $ = cheerio.load(html)

      let foundOnPage = 0

      $('a[href]').each((_, el) => {
        const a = $(el)
        const h2 = a.find('h2')
        if (!h2.length) return

        const name = h2.text().trim()
        if (!name) return

        const href = a.attr('href')

        const dateDiv = a.find('.date, [class*="date"]')
        let dateText = dateDiv.length ? dateDiv.text().trim() : ''

        if (!dateText) {
          const allText = a.text()
          const dateSearch = allText.match(/(\d{2})\.(\d{2})\.(\d{4})/)
          if (dateSearch) dateText = dateSearch[0]
        }

        const dateMatch = dateText.match(/(\d{2})\.(\d{2})\.(\d{4})/)
        if (!dateMatch) return
        const date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`

        // Try to find pipe-separated line: "City | voivodeship | Type"
        let location = ''
        let voivodeship = ''
        a.find('p').each((_, p) => {
          const text = $(p).text().trim()
          if (text.includes('|') && text.split('|').length >= 2) {
            const parts = text.split('|').map(s => s.trim())
            if (parts[0].length < 30) {
              location = parts[0]
              voivodeship = parts[1] || ''
            }
          }
        })

        eventEntries.push({
          name,
          date,
          location,
          voivodeship,
          href,
          needsDetail: !location,
        })

        foundOnPage++
      })

      if (foundOnPage === 0) break
      page++

      await new Promise(r => setTimeout(r, 1100))
    } catch (err) {
      console.error(`[biegiwpolsce] Listing scrape failed for page ${page}:`, err.message)
      break
    }
  }

  console.log(`[biegiwpolsce] Found ${eventEntries.length} events, ${eventEntries.filter(e => e.needsDetail).length} need detail page fetch`)

  // Step 2: fetch detail pages for events missing location
  for (const entry of eventEntries) {
    // Fetch detail page if missing location OR always for distances
    if (entry.href && (entry.needsDetail || !entry.distances)) {
      const detail = await fetchDetailPage(entry.href)
      if (detail) {
        if (detail.city) entry.location = detail.city
        if (detail.voivodeship) entry.voivodeship = detail.voivodeship
        if (detail.distances) entry.distances = detail.distances
        if (detail.rawDescription) entry.rawDescription = detail.rawDescription
      }
      await new Promise(r => setTimeout(r, 1100))
    }

    results.push({
      name: entry.name,
      date: entry.date,
      location: entry.location,
      voivodeship: entry.voivodeship,
      distances: entry.distances || '',
      description: entry.rawDescription || '',
      registration_url: null,
      source: 'biegiwpolsce',
      source_url: BASE_URL,
      source_id: entry.href || `${entry.name}-${entry.date}`,
    })
  }

  console.log(`[biegiwpolsce] Scraped ${results.length} events`)
  return results
}

export { scrape }
