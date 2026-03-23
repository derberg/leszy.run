import * as cheerio from 'cheerio'

const BASE_URL = 'https://www.biegiwpolsce.pl'

async function scrape() {
  const results = []
  let page = 1
  const maxPages = 10

  while (page <= maxPages) {
    try {
      const url = page === 1 ? BASE_URL : `${BASE_URL}/?page=${page}`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
      })
      const html = await res.text()
      const $ = cheerio.load(html)

      let foundOnPage = 0

      // Events have h2 for name, h3 for date, and paragraph with location details
      $('h2').each((_, el) => {
        const h2 = $(el)
        const name = h2.text().trim()
        if (!name) return

        // Look for date in nearby h3 or sibling elements
        const parent = h2.parent()
        const dateEl = parent.find('h3').first()
        const dateText = dateEl.text().trim()
        const dateMatch = dateText.match(/(\d{2})\.(\d{2})\.(\d{4})/)
        const date = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null

        if (!date) return

        // Location info from paragraph containing voivodeship
        const infoText = parent.text()
        const locationMatch = infoText.match(/([A-ZŁŚŻŹĆa-ząćęłńóśźż\s-]+)\s*\|\s*([a-ząćęłńóśźż-]+)\s*\|/i)
        const location = locationMatch ? locationMatch[1].trim() : ''
        const voivodeship = locationMatch ? locationMatch[2].trim() : ''

        // Link
        const link = parent.find('a[href*="/"]').first().attr('href')

        results.push({
          name,
          date,
          location,
          voivodeship,
          distances: '',
          registration_url: link ? (link.startsWith('http') ? link : `${BASE_URL}${link}`) : null,
          source: 'biegiwpolsce',
          source_url: url,
          source_id: `${name}-${date}`,
        })

        foundOnPage++
      })

      if (foundOnPage === 0) break
      page++

      // Rate limit
      await new Promise(r => setTimeout(r, 1100))
    } catch (err) {
      console.error(`[biegiwpolsce] Scrape failed for page ${page}:`, err.message)
      break
    }
  }

  console.log(`[biegiwpolsce] Scraped ${results.length} events from ${page - 1} pages`)
  return results
}

export { scrape }
