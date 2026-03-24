import * as cheerio from 'cheerio'

const BASE_URL = 'https://maratonypolskie.pl'

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

function parseEvents(html, today) {
  const $ = cheerio.load(html)
  const events = []
  const seen = new Set()

  // The page uses nested tables — cheerio flattens all <td> into one level.
  // Get ALL td elements and scan for the pattern: [icon] [date] [city] [name+link]
  // The search results section starts after "Wydarzenia wyszukane"
  const allCells = $('td')
  let inSearchResults = false
  let i = 0

  while (i < allCells.length) {
    const cellText = $(allCells[i]).text().trim()

    // Find start of search results section
    if (cellText.includes('wyszukane')) {
      inSearchResults = true
      i++
      // Skip header row (DYSC, DATA, MIEJSCE, NAZWA)
      while (i < allCells.length) {
        const h = $(allCells[i]).text().trim()
        if (h === 'NAZWA') { i++; break }
        i++
      }
      continue
    }

    if (!inSearchResults) { i++; continue }

    // In search results: pattern is [icon/empty] [date] [city] [name+link]
    // Date format: D.M.YYYY (day) or similar
    const dateMatch = cellText.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/)
    if (!dateMatch) { i++; continue }

    const date = `${dateMatch[3]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`

    // Skip past events
    if (date < today) { i++; continue }

    // Next cell: city (might include distance like "Kraków10 km.")
    i++
    if (i >= allCells.length) break
    const cityCell = $(allCells[i]).text().trim()
    const cityDistMatch = cityCell.match(/^(.+?)(\d+[\.,]?\d*\s*km\.?)$/i)
    const location = cityDistMatch ? cityDistMatch[1].trim() : cityCell
    const distance = cityDistMatch ? cityDistMatch[2].trim() : ''

    // Next cell: name with link
    i++
    if (i >= allCells.length) break
    const nameCell = $(allCells[i])
    const nameLink = nameCell.find('a').first()
    const name = nameLink.text().trim() || nameCell.text().trim()
    const href = nameLink.attr('href') || ''

    if (!name || name.length < 3) { i++; continue }

    // Dedup
    const key = `${name}-${date}`
    if (seen.has(key)) { i++; continue }
    seen.add(key)

    const codeMatch = href.match(/code=(\d+)/)
    const sourceId = codeMatch ? codeMatch[1] : key

    events.push({
      name,
      date,
      location,
      distances: distance,
      registration_url: href ? (href.startsWith('http') ? href : `${BASE_URL}/${href}`) : null,
      source: 'maratonypolskie',
      source_url: '',
      source_id: sourceId,
    })

    i++
  }

  return events
}

async function scrape() {
  const results = []
  const allSeen = new Set()
  const now = new Date()
  const today = now.toISOString().split('T')[0]
  const startMonth = now.getMonth()
  const startYear = now.getFullYear()

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
      const events = parseEvents(html, today)

      let added = 0
      for (const event of events) {
        const key = `${event.name}-${event.date}`
        if (!allSeen.has(key)) {
          allSeen.add(key)
          event.source_url = url
          results.push(event)
          added++
        }
      }

      console.log(`[maratonypolskie] ${monthName} ${year}: ${added} new events (total: ${results.length})`)
      await new Promise(r => setTimeout(r, 1100))
    } catch (err) {
      console.error(`[maratonypolskie] Failed for ${monthName}/${year}:`, err.message)
    }
  }

  console.log(`[maratonypolskie] Scraped ${results.length} events total`)
  return results
}

export { scrape }
