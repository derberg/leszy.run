import * as cheerio from 'cheerio'

const BASE_URL = 'https://www.zmierzymyczas.pl'

async function fetchDetailPage(href) {
  try {
    const url = href.startsWith('http') ? href : `${BASE_URL}${href}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) return null

    const html = await res.text()
    const $ = cheerio.load(html)

    // Regulamin PDF link — pattern: /images/regulaminy/*.pdf
    let regulaminUrl = null
    $('a[href*="/images/regulaminy/"]').each((_, el) => {
      const h = $(el).attr('href')
      if (h && h.endsWith('.pdf')) {
        regulaminUrl = h.startsWith('http') ? h : `${BASE_URL}${h}`
      }
    })

    // Registration form link — pattern: /edit/{id}/{slug}.html
    let registrationUrl = null
    $('a[href*="/edit/"]').each((_, el) => {
      const h = $(el).attr('href')
      if (h) {
        registrationUrl = h.startsWith('http') ? h : `${BASE_URL}${h}`
      }
    })

    return { regulaminUrl, registrationUrl }
  } catch (err) {
    return null
  }
}

async function scrape({ knownIds = new Set() } = {}) {
  const results = []

  try {
    const res = await fetch(`${BASE_URL}/`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    const entries = []

    $('table.table-bordered.zebra tbody tr').each((_, el) => {
      const row = $(el)
      const cells = row.find('td')

      const dateCell = cells.filter('#zapisy_list_data').first()
      const nameCell = cells.filter('#zapisy_list_nazwa').first()
      const distCell = cells.filter('#zapisy_list_dystans').first()
      const locCell = cells.filter('#zapisy_list_miejsce').first()

      const date = dateCell.find('a').text().trim()
      const name = nameCell.find('a').text().trim()
      const distances = distCell.find('a').text().trim()
      const location = locCell.find('a').text().trim()
      const href = nameCell.find('a').attr('href')

      if (!name || !date) return

      // Extract source_id from href like /2484/slug.html
      const idMatch = href ? href.match(/^\/(\d+)\//) : null
      const sourceId = idMatch ? idMatch[1] : null
      if (!sourceId) return

      entries.push({ name, date, distances, location, href, sourceId })
    })

    const newEntries = entries.filter(e => !knownIds.has(e.sourceId))
    console.log(`[zmierzymyczas] Found ${entries.length} events, ${newEntries.length} new (skipping ${entries.length - newEntries.length} known)`)

    for (let i = 0; i < newEntries.length; i++) {
      const entry = newEntries[i]

      const detail = await fetchDetailPage(entry.href)

      const sourceUrl = `${BASE_URL}${entry.href}`
      results.push({
        name: entry.name,
        date: entry.date,
        location: entry.location || null,
        distances: entry.distances || null,
        registration_url: detail?.registrationUrl || null,
        regulamin_url: detail?.regulaminUrl || null,
        // No external organizer-site detection here — the enricher upgrades this
        // later if it finds a real organizer domain. Default to the public info
        // page (same URL as source_url) so events without a separate website
        // still have a usable "Strona wydarzenia" link instead of NULL.
        website: sourceUrl,
        source: 'zmierzymyczas',
        source_url: sourceUrl,
        source_id: entry.sourceId,
      })

      // Rate limit
      await new Promise(r => setTimeout(r, 1100))

      if ((i + 1) % 50 === 0) {
        console.log(`[zmierzymyczas] Detail pages: ${i + 1}/${newEntries.length}`)
      }
    }

    console.log(`[zmierzymyczas] Scraped ${results.length} events with details`)
  } catch (err) {
    console.error('[zmierzymyczas] Scrape failed:', err.message)
  }

  return results
}

export { scrape }
