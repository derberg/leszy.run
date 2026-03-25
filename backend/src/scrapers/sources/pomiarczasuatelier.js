import * as cheerio from 'cheerio'

const BASE_URL = 'https://pomiarczasuatelier.pl'
const LIST_URL = `${BASE_URL}/zapisy/`

async function scrape() {
  const results = []

  try {
    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    $('div.brxe-aknqgz').each((_, el) => {
      const card = $(el)

      const name = card.find('h3.brxe-post-title').text().trim()
      if (!name) return

      // Date from first icon-box
      const dateText = card.find('.brxe-otzfxb .content p').text().trim()
      const dateMatch = dateText.match(/(\d{2})\.(\d{2})\.(\d{4})/)
      if (!dateMatch) return
      const date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`

      // Location from third icon-box
      const location = card.find('.brxe-cienzu .content p').text().trim()

      // Detail page link
      const detailLink = card.find('a.bricks-background-primary').attr('href') || ''

      // Registration link (dostartu.pl)
      const regLink = card.find('a.bricks-background-secondary').attr('href') || ''

      // Use registration link if available, otherwise detail page
      const registrationUrl = regLink || detailLink || null

      // Source ID from detail page slug
      const slug = detailLink.replace(BASE_URL, '').replace(/^\/|\/$/g, '')
      const sourceId = slug || `${name}-${date}`

      results.push({
        name,
        date,
        location: location || '',
        distances: '',
        registration_url: registrationUrl,
        source: 'pomiarczasuatelier',
        source_url: LIST_URL,
        source_id: sourceId,
      })
    })

    console.log(`[pomiarczasuatelier] Scraped ${results.length} events`)
  } catch (err) {
    console.error('[pomiarczasuatelier] Scrape failed:', err.message)
  }

  return results
}

export { scrape }
