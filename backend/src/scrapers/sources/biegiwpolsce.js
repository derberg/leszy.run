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

      // Events are <a> elements containing <h2> for name and .date or date text
      $('a[href]').each((_, el) => {
        const a = $(el)
        const h2 = a.find('h2')
        if (!h2.length) return

        const name = h2.text().trim()
        if (!name) return

        const href = a.attr('href')

        // Find date: look for div.date or any element with DD.MM.YYYY pattern
        const dateDiv = a.find('.date, [class*="date"]')
        let dateText = dateDiv.length ? dateDiv.text().trim() : ''

        if (!dateText) {
          // Fallback: search all text for date pattern
          const allText = a.text()
          const dateSearch = allText.match(/(\d{2})\.(\d{2})\.(\d{4})/)
          if (dateSearch) dateText = dateSearch[0]
        }

        const dateMatch = dateText.match(/(\d{2})\.(\d{2})\.(\d{4})/)
        if (!dateMatch) return
        const date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`

        // Location and type from <p> text
        // Format: "City | voivodeship | Type | SubType"
        const pText = a.find('p').last().text().trim()
        const parts = pText.split('|').map(s => s.trim())
        const location = parts[0] || ''
        const voivodeship = parts[1] || ''

        results.push({
          name,
          date,
          location,
          voivodeship,
          distances: '',
          registration_url: href ? (href.startsWith('http') ? href : `${BASE_URL}${href}`) : null,
          source: 'biegiwpolsce',
          source_url: url,
          source_id: href || `${name}-${date}`,
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
