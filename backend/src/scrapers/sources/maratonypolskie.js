import * as cheerio from 'cheerio'

const BASE_URL = 'https://maratonypolskie.pl'

function buildCalendarUrl(month, year) {
  return `${BASE_URL}/mp_index.php?dzial=3&action=1&grp=13&trgr=1&bieganie&wielkosc=2&czasm1=${month}&czasr1=${year}`
}

async function fetchWithEncoding(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
  })
  // Site uses ISO-8859-2 encoding for Polish characters
  const buffer = await res.arrayBuffer()
  const decoder = new TextDecoder('iso-8859-2')
  return decoder.decode(buffer)
}

async function scrape() {
  const results = []
  const now = new Date()
  const startMonth = now.getMonth() + 1 // 1-indexed
  const startYear = now.getFullYear()

  // Scrape 12 months ahead
  for (let i = 0; i < 12; i++) {
    let month = startMonth + i
    let year = startYear
    if (month > 12) {
      month -= 12
      year++
    }

    try {
      const url = buildCalendarUrl(month, year)
      const html = await fetchWithEncoding(url)
      const $ = cheerio.load(html)

      $('tr').each((_, el) => {
        const cells = $(el).find('td')
        if (cells.length < 4) return

        // Find a date cell (format: YYYY.M.DD)
        let dateText = null
        let dateCell = -1
        cells.each((idx, cell) => {
          const text = $(cell).text().trim()
          if (/^\d{4}\.\d{1,2}\.\d{1,2}/.test(text)) {
            dateText = text
            dateCell = idx
          }
        })

        if (!dateText || dateCell < 0) return

        const dateMatch = dateText.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/)
        if (!dateMatch) return

        const date = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`

        // Skip past events
        if (date < now.toISOString().split('T')[0]) return

        // Find event name link
        let name = null
        let href = null
        cells.each((idx, cell) => {
          const link = $(cell).find('a[href*="code="]').first()
          if (link.length) {
            name = link.text().trim()
            href = link.attr('href')
          }
        })

        if (!name) {
          cells.each((idx, cell) => {
            const link = $(cell).find('a').first()
            const text = link.text().trim()
            if (text && text.length > 5 && !name) {
              name = text
              href = link.attr('href')
            }
          })
        }

        if (!name) return

        // Location and distance from remaining cells
        let location = ''
        let distance = ''
        cells.each((idx, cell) => {
          const text = $(cell).text().trim()
          if (/\d+.*km/i.test(text)) {
            distance = text
          }
          if (idx !== dateCell && text.length > 2 && !/\d{4}\.\d/.test(text) && !/km/i.test(text) && !$(cell).find('a').length && !$(cell).find('img').length) {
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
          source_url: buildCalendarUrl(month, year),
          source_id: sourceId,
        })
      })

      console.log(`[maratonypolskie] Month ${month}/${year}: found events so far: ${results.length}`)

      // Rate limit between pages
      await new Promise(r => setTimeout(r, 1100))
    } catch (err) {
      console.error(`[maratonypolskie] Failed for ${month}/${year}:`, err.message)
    }
  }

  console.log(`[maratonypolskie] Scraped ${results.length} events total`)
  return results
}

export { scrape }
