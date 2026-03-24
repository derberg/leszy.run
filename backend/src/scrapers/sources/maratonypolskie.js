import * as cheerio from 'cheerio'

const BASE_URL = 'https://maratonypolskie.pl'
// Default page shows current month's events (~190). Month switching requires PHP sessions
// we can't replicate with simple fetch. As time passes, each run captures that month's events.
const SEARCH_URL = `${BASE_URL}/mp_index.php?dzial=3&action=1&grp=13&trgr=1&bieganie&wyswietl=Tekstowo&region=Polska`

async function fetchWithEncoding(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
  })
  const buffer = await res.arrayBuffer()
  const decoder = new TextDecoder('iso-8859-2')
  return decoder.decode(buffer)
}

async function scrape() {
  const events = []
  const seen = new Set()
  const today = new Date().toISOString().split('T')[0]

  try {
    const html = await fetchWithEncoding(SEARCH_URL)
    const $ = cheerio.load(html)

    // Site uses nested tables — cheerio flattens all <td> into one level.
    // Scan for the "wyszukane" (search results) section, then parse
    // sequential cell pattern: [icon/empty] [date] [city] [name+link]
    const allCells = $('td')
    let inSearchResults = false

    for (let i = 0; i < allCells.length; i++) {
      const cellText = $(allCells[i]).text().trim()

      if (cellText.includes('wyszukane')) {
        inSearchResults = true
        // Skip header row (DYSC, DATA, MIEJSCE, NAZWA)
        while (i < allCells.length) {
          if ($(allCells[i]).text().trim() === 'NAZWA') { i++; break }
          i++
        }
        continue
      }

      if (!inSearchResults) continue

      // Look for date pattern: D.M.YYYY (day)
      const dateMatch = cellText.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/)
      if (!dateMatch) continue

      const date = `${dateMatch[3]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`
      if (date < today) continue

      // Next cell: city (might include distance like "Kraków10 km.")
      i++
      if (i >= allCells.length) break
      const cityText = $(allCells[i]).text().trim()
      const cityDistMatch = cityText.match(/^(.+?)(\d+[\.,]?\d*\s*km\.?)$/i)
      const location = cityDistMatch ? cityDistMatch[1].trim() : cityText
      const distance = cityDistMatch ? cityDistMatch[2].trim() : ''

      // Next cell: name with link
      i++
      if (i >= allCells.length) break
      const nameCell = $(allCells[i])
      const nameLink = nameCell.find('a').first()
      const name = nameLink.text().trim() || nameCell.text().trim()
      const href = nameLink.attr('href') || ''

      if (!name || name.length < 3) continue

      const key = `${name}-${date}`
      if (seen.has(key)) continue
      seen.add(key)

      const codeMatch = href.match(/code=(\d+)/)
      const sourceId = codeMatch ? codeMatch[1] : key

      events.push({
        name,
        date,
        location: location.length > 1 && location.length < 40 ? location : '',
        distances: distance,
        registration_url: href ? (href.startsWith('http') ? href : `${BASE_URL}/${href}`) : null,
        source: 'maratonypolskie',
        source_url: SEARCH_URL,
        source_id: sourceId,
      })
    }

    console.log(`[maratonypolskie] Scraped ${events.length} events`)
  } catch (err) {
    console.error('[maratonypolskie] Scrape failed:', err.message)
  }

  return events
}

export { scrape }
