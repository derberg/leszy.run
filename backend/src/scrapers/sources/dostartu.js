import * as cheerio from 'cheerio'

const BASE_URL = 'https://dostartu.pl'

async function scrape() {
  const results = []

  try {
    // TODO: inspect dostartu.pl HTML structure and adjust selectors
    const res = await fetch(`${BASE_URL}/kalendarz-biegow`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    $('[class*="event"], [class*="item"]').each((_, el) => {
      const name = $(el).find('[class*="name"], [class*="title"], h3, h4').text().trim()
      const date = $(el).find('[class*="date"]').text().trim()
      const location = $(el).find('[class*="location"], [class*="place"]').text().trim()
      const distances = $(el).find('[class*="distance"], [class*="dystans"]').text().trim()
      const link = $(el).find('a').attr('href')

      if (name && date) {
        results.push({
          name,
          date,
          location,
          distances,
          registration_url: link ? (link.startsWith('http') ? link : `${BASE_URL}${link}`) : null,
          source: 'dostartu',
          source_url: `${BASE_URL}/kalendarz-biegow`,
          source_id: link || `${name}-${date}`,
        })
      }
    })

    console.log(`[dostartu] Scraped ${results.length} events`)
  } catch (err) {
    console.error('[dostartu] Scrape failed:', err.message)
  }

  return results
}

export { scrape }
