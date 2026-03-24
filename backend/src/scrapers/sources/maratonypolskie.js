import * as cheerio from 'cheerio'

const BASE_URL = 'https://maratonypolskie.pl'

// Polish month names as used in the form params
const MONTHS_PL = [
  'styczen', 'luty', 'marzec', 'kwiecien', 'maj', 'czerwiec',
  'lipiec', 'sierpien', 'wrzesien', 'pazdziernik', 'listopad', 'grudzien'
]

function buildSearchUrl(monthName, year) {
  return `${BASE_URL}/mp_index.php?dzial=3&action=1&grp=13&trgr=1&bieganie&wyswietl=Tekstowo&miesiac=${monthName}&rok=${year}&region=Polska`
}

async function fetchWithEncoding(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
  })
  const buffer = await res.arrayBuffer()
  const decoder = new TextDecoder('iso-8859-2')
  return decoder.decode(buffer)
}

async function scrape() {
  const results = []
  const seen = new Set()
  const now = new Date()
  const today = now.toISOString().split('T')[0]
  const startMonth = now.getMonth() // 0-indexed
  const startYear = now.getFullYear()

  // Scrape 12 months ahead
  for (let i = 0; i < 12; i++) {
    let monthIdx = startMonth + i
    let year = startYear
    if (monthIdx >= 12) {
      monthIdx -= 12
      year++
    }

    const monthName = MONTHS_PL[monthIdx]

    try {
      const url = buildSearchUrl(monthName, year)
      const html = await fetchWithEncoding(url)
      const $ = cheerio.load(html)

      let monthCount = 0

      // Search results are in a table in the "Wydarzenia wyszukane" section
      // Each row has columns: discipline icon | date | city | distance | event name (linked)
      $('tr').each((_, el) => {
        const cells = $(el).find('td')
        if (cells.length < 3) return

        // Find date cell: format "YYYY.M.DD" or "D.M.YYYY"
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
        if (date < today) return

        // Find event name — look for any <a> with reasonable text
        let name = null
        let href = null
        cells.each((idx, cell) => {
          $(cell).find('a').each((_, a) => {
            const text = $(a).text().trim()
            const link = $(a).attr('href') || ''
            // Skip short links like "ZGŁ" (registration button) and icon links
            if (text.length > 5 && !name && !link.includes('zapisy') && !link.includes('datasport')) {
              name = text
              href = link
            }
          })
        })

        if (!name) return

        // Dedup by name+date
        const key = `${name}-${date}`
        if (seen.has(key)) return
        seen.add(key)

        // Location: cell with text that's not date, not distance, not name, not icon
        let location = ''
        let distance = ''
        cells.each((idx, cell) => {
          const text = $(cell).text().trim()
          if (/\d+[\.,]?\d*\s*km/i.test(text)) {
            distance = text
          } else if (idx !== dateCell && text.length > 1 && text.length < 40 && !/\d{4}\.\d/.test(text) && !$(cell).find('a').length && !$(cell).find('img').length) {
            location = text
          }
        })

        const codeMatch = href ? href.match(/code=(\d+)/) : null
        const sourceId = codeMatch ? codeMatch[1] : key

        results.push({
          name,
          date,
          location,
          distances: distance,
          registration_url: href ? (href.startsWith('http') ? href : `${BASE_URL}/${href}`) : null,
          source: 'maratonypolskie',
          source_url: url,
          source_id: sourceId,
        })

        monthCount++
      })

      console.log(`[maratonypolskie] ${monthName} ${year}: ${monthCount} events (total so far: ${results.length})`)

      // Rate limit between pages
      await new Promise(r => setTimeout(r, 1100))
    } catch (err) {
      console.error(`[maratonypolskie] Failed for ${monthName}/${year}:`, err.message)
    }
  }

  console.log(`[maratonypolskie] Scraped ${results.length} events total`)
  return results
}

export { scrape }
