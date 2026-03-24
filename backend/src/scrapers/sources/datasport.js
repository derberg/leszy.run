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
    const pageText = $('body').text().replace(/\s+/g, ' ').trim()

    // Extract distances
    const distances = []
    const kmMatches = [...pageText.matchAll(/(\d+[\.,]?\d*)\s*km/gi)]
    for (const m of kmMatches) {
      const km = parseFloat(m[1].replace(',', '.'))
      const label = `${km} km`
      if (km > 0 && km < 500 && !distances.includes(label)) distances.push(label)
    }
    if (pageText.toLowerCase().includes('półmaraton') && !distances.some(d => d.includes('21'))) {
      distances.push('21.1 km')
    }
    if (/\bmaraton\b/i.test(pageText) && !pageText.toLowerCase().includes('pół') && !distances.some(d => d.includes('42'))) {
      distances.push('42.2 km')
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
      let description = ''

      const detail = await fetchDetailPage(entry.sourceId)
      if (detail) {
        distances = detail.distances
        description = detail.rawDescription
      }

      results.push({
        name: entry.name,
        date: entry.date,
        location: entry.location,
        distances,
        description,
        registration_url: entry.href,
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
