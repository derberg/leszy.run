import * as cheerio from 'cheerio'

const BASE_URL = 'https://maratonypolskie.pl'
const CALENDAR_URL = `${BASE_URL}/mp_index.php?dzial=3&action=1&grp=13&trgr=1&bieganie&wielkosc=2`

async function scrape() {
  const results = []

  try {
    const res = await fetch(CALENDAR_URL, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    // Events are in table rows. Each row has cells: icon, date, city, distance, name+link
    $('tr').each((_, el) => {
      const cells = $(el).find('td')
      if (cells.length < 5) return

      const dateText = $(cells[1]).text().trim()
      const location = $(cells[2]).text().trim()
      const distance = $(cells[3]).text().trim()
      const nameCell = $(cells[4])
      const nameLink = nameCell.find('a').first()
      const name = nameLink.text().trim() || nameCell.text().trim()
      const href = nameLink.attr('href')

      if (!name || !dateText) return

      // Parse date from "YYYY.M.DD (day)" format
      const dateMatch = dateText.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/)
      const date = dateMatch
        ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
        : dateText

      // Extract event code from href for source_id
      const codeMatch = href ? href.match(/code=(\d+)/) : null
      const sourceId = codeMatch ? codeMatch[1] : `${name}-${date}`

      results.push({
        name,
        date,
        location,
        distances: distance,
        registration_url: href ? `${BASE_URL}/${href}` : null,
        source: 'maratonypolskie',
        source_url: CALENDAR_URL,
        source_id: sourceId,
      })
    })

    console.log(`[maratonypolskie] Scraped ${results.length} events`)
  } catch (err) {
    console.error('[maratonypolskie] Scrape failed:', err.message)
  }

  return results
}

export { scrape }
