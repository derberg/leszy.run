import * as cheerio from 'cheerio'

const BASE_URL = 'https://liveds.datasport.pl'
const LIST_URL = `${BASE_URL}/lista.html`

async function fetchDetailPage(eventId) {
  try {
    const url = `${BASE_URL}/zawody_files/zawody${eventId}.html`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) return null

    const buffer = await res.arrayBuffer()
    const html = new TextDecoder('windows-1250').decode(buffer)
    const $ = cheerio.load(html)

    // Extract distances from <h4> race category headings in the section after #features.
    // Structure: <section id="features">...</section> <section>...<h4>Bieg 10km</h4>...
    // These headings contain the actual race names with distances — no junk.
    const distances = []
    const featuresSection = $('section#features')
    const categorySection = featuresSection.next('section')
    const headings = categorySection.length ? categorySection.find('h4') : $('h4')

    headings.each((_, el) => {
      const text = $(el).text().trim()
      // Extract km from heading like "Bieg 10km", "Bieg 5 km", "Półmaraton"
      const kmMatch = text.match(/(\d+[.,]?\d*)\s*km/i)
      if (kmMatch) {
        const km = parseFloat(kmMatch[1].replace(',', '.'))
        const label = `${km} km`
        if (km > 0 && km < 500 && !distances.includes(label)) distances.push(label)
      }
      // Named distances
      if (/półmaraton|polmaraton/i.test(text) && !distances.some(d => d.includes('21'))) {
        distances.push('21.1 km')
      }
      if (/\bmaraton\b/i.test(text) && !/pół|pol/i.test(text) && !distances.some(d => d.includes('42'))) {
        distances.push('42.2 km')
      }
      // Time-based durations (e.g., "Bieg 4h", "Bieg 6H")
      const hourMatch = text.match(/\b(\d{1,2})\s*[hH]\b/)
      if (hourMatch) {
        const hours = parseInt(hourMatch[1])
        const label = `${hours}h`
        if (hours > 0 && hours <= 48 && !distances.includes(label)) distances.push(label)
      }
    })

    // Regulamin PDF URL
    const regulaminLink = $(`a[href*="regulaminy/regulamin_${eventId}.pdf"]`).attr('href') || null

    return {
      distances: distances.join(', '),
      regulaminUrl: regulaminLink,
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

      let regulaminUrl = null
      const detail = await fetchDetailPage(entry.sourceId)
      if (detail) {
        distances = detail.distances
        regulaminUrl = detail.regulaminUrl
      }

      results.push({
        name: entry.name,
        date: entry.date,
        location: entry.location,
        distances,
        registration_url: null,
        regulamin_url: regulaminUrl,
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
