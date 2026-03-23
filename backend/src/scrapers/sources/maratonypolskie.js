import * as cheerio from 'cheerio'

const BASE_URL = 'https://maratonypolskie.pl'

async function scrape() {
  const results = []

  try {
    // TODO: inspect maratonypolskie.pl HTML structure and adjust selectors
    const res = await fetch(`${BASE_URL}/kalendarz`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    $('[class*="event"], [class*="row"], tr').each((_, el) => {
      const name = $(el).find('[class*="name"], [class*="title"], td:nth-child(2)').text().trim()
      const date = $(el).find('[class*="date"], td:nth-child(1)').text().trim()
      const location = $(el).find('[class*="location"], [class*="place"], td:nth-child(3)').text().trim()
      const distances = $(el).find('[class*="distance"], [class*="dystans"], td:nth-child(4)').text().trim()
      const link = $(el).find('a').attr('href')

      if (name && date) {
        results.push({
          name,
          date,
          location,
          distances,
          registration_url: link ? (link.startsWith('http') ? link : `${BASE_URL}${link}`) : null,
          source: 'maratonypolskie',
          source_url: `${BASE_URL}/kalendarz`,
          source_id: link || `${name}-${date}`,
        })
      }
    })

    console.log(`[maratonypolskie] Scraped ${results.length} events`)
  } catch (err) {
    console.error('[maratonypolskie] Scrape failed:', err.message)
  }

  return results
}

export { scrape }
