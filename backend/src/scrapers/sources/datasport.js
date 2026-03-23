import * as cheerio from 'cheerio'

const BASE_URL = 'https://liveds.datasport.pl'
const LIST_URL = `${BASE_URL}/lista.html`

async function scrape() {
  const results = []

  try {
    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    $('.event-list-box').each((_, el) => {
      const box = $(el)
      const nameLink = box.find('h5 a').first()
      const name = nameLink.text().trim()
      const href = nameLink.attr('href')

      // Date is in a text node, format YYYY-MM-DD
      const allText = box.text()
      const dateMatch = allText.match(/(\d{4}-\d{2}-\d{2})/)
      const date = dateMatch ? dateMatch[1] : null

      // Location is in an <li> element
      const location = box.find('li').first().text().trim()

      if (!name || !date) return

      // Extract event ID from href (e.g., zawody11469.html -> 11469)
      const idMatch = href ? href.match(/zawody(\d+)/) : null
      const sourceId = idMatch ? idMatch[1] : `${name}-${date}`

      results.push({
        name,
        date,
        location,
        distances: '',
        registration_url: href ? (href.startsWith('http') ? href : `${BASE_URL}/${href}`) : null,
        source: 'datasport',
        source_url: LIST_URL,
        source_id: sourceId,
      })
    })

    console.log(`[datasport] Scraped ${results.length} events`)
  } catch (err) {
    console.error('[datasport] Scrape failed:', err.message)
  }

  return results
}

export { scrape }
