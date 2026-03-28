import * as cheerio from 'cheerio'

const BASE_URL = 'https://liveds.datasport.pl'
const LIST_URL = `${BASE_URL}/lista.html`

async function fetchDetailPage(eventId) {
  try {
    // zawody_files/ path works (direct zawodyNNN.html returns 403)
    const url = `${BASE_URL}/zawody_files/zawody${eventId}.html`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) return null

    const buffer = await res.arrayBuffer()
    const html = new TextDecoder('windows-1250').decode(buffer)
    const $ = cheerio.load(html)

    // Extract distances only from the event description area, not participant stats.
    // Datasport pages have "Pokonał/Pokonała XXX km" (cumulative participant stats)
    // and "Półmaraton"/"Maraton" in participant history sections — strip those out.
    const pageText = $('body').text().replace(/\s+/g, ' ').trim()
    const cleanText = pageText
      .replace(/Pokona[łl]a?\s+[\d.,]+\s*km/gi, '')   // strip "Pokonał 221.14 km"
      .replace(/przebieg[łl]a?\s+[\d.,]+\s*km/gi, '')  // strip "Przebiegł 150 km"

    // Extract distances from cleaned text
    const distances = []
    const kmMatches = [...cleanText.matchAll(/(\d+[\.,]?\d*)\s*km/gi)]
    for (const m of kmMatches) {
      const km = parseFloat(m[1].replace(',', '.'))
      const label = `${km} km`
      if (km > 0 && km < 100 && !distances.includes(label)) distances.push(label)
    }
    // Named distances — only from event name, not page text (avoids participant history)
    // These are checked per-event in the normalizer from the event name
    // If no km distances, look for time-based durations (e.g., "4h", "6h", "8h")
    if (distances.length === 0) {
      const hourMatches = [...pageText.matchAll(/\b(\d{1,2})\s*[hH]\b/g)]
      for (const m of hourMatches) {
        const hours = parseInt(m[1])
        const label = `${hours}h`
        if (hours > 0 && hours <= 48 && !distances.includes(label)) distances.push(label)
      }
    }

    return {
      distances: distances.join(', '),
      rawDescription: pageText.slice(0, 5000),
    }
  } catch (err) {
    return null
  }
}

async function scrape() {
  const results = []

  try {
    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const buffer = await res.arrayBuffer()
    const html = new TextDecoder('windows-1250').decode(buffer)
    const $ = cheerio.load(html)

    const entries = []

    $('.event-list-box').each((_, el) => {
      const box = $(el)
      const nameLink = box.find('h5 a').first()
      const name = nameLink.text().trim()
      const href = nameLink.attr('href')

      const allText = box.text()
      const dateMatch = allText.match(/(\d{4}-\d{2}-\d{2})/)
      const date = dateMatch ? dateMatch[1] : null

      const location = box.find('li').first().text().trim()

      if (!name || !date) return

      const idMatch = href ? href.match(/zawody(\d+)/) : null
      const sourceId = idMatch ? idMatch[1] : `${name}-${date}`

      entries.push({
        name, date, location, sourceId,
        href: href ? (href.startsWith('http') ? href : `${BASE_URL}/${href}`) : null,
      })
    })

    console.log(`[datasport] Found ${entries.length} events, fetching details...`)

    // Fetch detail pages
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      let distances = ''

      const detail = await fetchDetailPage(entry.sourceId)
      if (detail) {
        distances = detail.distances
      }

      results.push({
        name: entry.name,
        date: entry.date,
        location: entry.location,
        distances,
        registration_url: null,
        source: 'datasport',
        source_url: LIST_URL,
        source_id: entry.sourceId,
      })

      // Rate limit
      await new Promise(r => setTimeout(r, 1100))

      if ((i + 1) % 50 === 0) {
        console.log(`[datasport] Detail pages: ${i + 1}/${entries.length}`)
      }
    }

    console.log(`[datasport] Scraped ${results.length} events with details`)
  } catch (err) {
    console.error('[datasport] Scrape failed:', err.message)
  }

  return results
}

export { scrape }
