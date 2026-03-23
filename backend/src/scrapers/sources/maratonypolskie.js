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

    $('tr').each((_, el) => {
      const cells = $(el).find('td')
      if (cells.length < 4) return

      // Try to find a date in any cell (format: YYYY.M.DD or YYYY.MM.DD)
      let dateText = null
      let dateCell = -1
      cells.each((i, cell) => {
        const text = $(cell).text().trim()
        if (/^\d{4}\.\d{1,2}\.\d{1,2}/.test(text)) {
          dateText = text
          dateCell = i
        }
      })

      if (!dateText || dateCell < 0) return

      // Parse date
      const dateMatch = dateText.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/)
      if (!dateMatch) return
      const date = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`

      // Find the cell with an event link (contains <a> with code= in href)
      let name = null
      let href = null
      cells.each((i, cell) => {
        const link = $(cell).find('a[href*="code="]').first()
        if (link.length) {
          name = link.text().trim()
          href = link.attr('href')
        }
      })

      if (!name) {
        // Fallback: find any <a> that looks like an event name (not "ZGL" or short text)
        cells.each((i, cell) => {
          const link = $(cell).find('a').first()
          const text = link.text().trim()
          if (text && text.length > 5 && !name) {
            name = text
            href = link.attr('href')
          }
        })
      }

      if (!name) return

      // Location: typically the cell after date or before the name cell
      let location = ''
      let distance = ''
      cells.each((i, cell) => {
        const text = $(cell).text().trim()
        // Distance: contains "km"
        if (/\d+.*km/i.test(text)) {
          distance = text
        }
        // Location: not a date, not distance, not the name, not a number, not too short
        if (i !== dateCell && text.length > 2 && !/\d{4}\.\d/.test(text) && !/km/i.test(text) && !$(cell).find('a').length && !$(cell).find('img').length) {
          location = text
        }
      })

      const codeMatch = href ? href.match(/code=(\d+)/) : null
      const sourceId = codeMatch ? codeMatch[1] : `${name}-${date}`

      results.push({
        name,
        date,
        location,
        distances: distance,
        registration_url: href ? (href.startsWith('http') ? href : `${BASE_URL}/${href}`) : null,
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
