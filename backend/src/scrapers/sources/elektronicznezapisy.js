import * as cheerio from 'cheerio'

const BASE_URL = 'https://elektronicznezapisy.pl'

const CATEGORY_URLS = [
  { url: `${BASE_URL}/1/bieg.html`, type: 'running' },
  { url: `${BASE_URL}/2/nordic-walking.html`, type: 'nordic' },
]

async function scrape() {
  const results = []

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

        // Cell 1: name + link + datetime
        const nameCell = $(cells[1])
        const nameLink = nameCell.find('a').first()
        const name = nameLink.text().trim()
        const href = nameLink.attr('href')

        // Cell 2: date (YYYY-MM-DD or YYYY-MM-DD HH:MM)
        const dateText = $(cells[2]).text().trim()
        const dateMatch = dateText.match(/(\d{4}-\d{2}-\d{2})/)
        const date = dateMatch ? dateMatch[1] : null

        // Cell with signup link
        const signupLink = $(el).find('a[href*="signup"]').attr('href')

        if (!name || !date) return

        // Extract event ID from href
        const idMatch = href ? href.match(/event\/(\d+)/) : null
        const sourceId = idMatch ? idMatch[1] : `${name}-${date}`

        results.push({
          name,
          date,
          location: '',
          distances: '',
          registration_url: signupLink ? `${BASE_URL}/${signupLink}` : (href ? `${BASE_URL}/${href}` : null),
          source: 'elektronicznezapisy',
          source_url: category.url,
          source_id: sourceId,
        })
      })
    } catch (err) {
      console.error(`[elektronicznezapisy] Scrape failed for ${category.url}:`, err.message)
    }
  }

  console.log(`[elektronicznezapisy] Scraped ${results.length} events`)
  return results
}

export { scrape }
