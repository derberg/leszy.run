import * as cheerio from 'cheerio'

const BASE_URL = 'https://elektronicznezapisy.pl'

const CATEGORY_URLS = [
  { url: `${BASE_URL}/1/bieg.html`, type: 'running' },
  { url: `${BASE_URL}/2/nordic-walking.html`, type: 'nordic' },
]

// Known scraper source domains — if the event links to one of these, save the link
// but don't try to extract further data (the other scraper will handle it)
const KNOWN_SOURCE_DOMAINS = [
  'maratonypolskie.pl',
  'datasport.pl',
  'liveds.datasport.pl',
  'biegiwpolsce.pl',
  'dostartu.pl',
  'pomiarczasuatelier.pl',
]

function isKnownSourceUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return KNOWN_SOURCE_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`))
  } catch {
    return false
  }
}

async function fetchDetailPage(eventId) {
  try {
    const url = `${BASE_URL}/event/${eventId}/strona.html`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    // Name from <h1>
    const name = $('h1').first().text().trim()

    // City: try multiple patterns
    let location = null

    // Pattern 1: <a href="/m/city">City</a>
    const cityLink = $('a[href^="/m/"]').first()
    if (cityLink.length) {
      location = cityLink.text().trim()
    }

    // Pattern 2: "Miejsce: <strong>City</strong>" in list-group-item
    if (!location) {
      $('li.list-group-item').each((_, el) => {
        const text = $(el).text().trim()
        const match = text.match(/Miejsce:\s*(.+)/i)
        if (match && !location) {
          location = match[1].trim()
        }
      })
    }

    // Date from "Początek imprezy" list item
    let date = null
    $('li.list-group-item').each((_, el) => {
      const text = $(el).text().trim()
      const match = text.match(/Początek imprezy:\s*(\d{4})[.\-](\d{2})[.\-](\d{2})/)
      if (match && !date) {
        date = `${match[1]}-${match[2]}-${match[3]}`
      }
    })
    // Fallback: any YYYY.MM.DD / YYYY-MM-DD in body
    if (!date) {
      const bodyText = $('body').text()
      const dateMatch = bodyText.match(/(\d{4})[.\-](\d{2})[.\-](\d{2})/)
      if (dateMatch) date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
    }

    // Distances from Cennik (pricing) section — most reliable structured source.
    // Each pricing row starts with category name like "5 km - dorośli", "21 km - open"
    const distances = []
    const seen = new Set()
    $('li.list-group-item-info').each((_, header) => {
      if ($(header).text().trim() !== 'Cennik') return
      const cennikList = $(header).closest('ul.list-group')
      cennikList.find('td:first-child').each((_, td) => {
        const text = $(td).text().trim()
        const kmMatch = text.match(/^(\d+[.,]?\d*)\s*km/i)
        if (kmMatch) {
          const km = parseFloat(kmMatch[1].replace(',', '.'))
          const label = `${km} km`
          if (km > 0 && km < 500 && !seen.has(label)) {
            distances.push(label)
            seen.add(label)
          }
        }
        // Named distances
        if (/półmaraton|polmaraton/i.test(text) && !seen.has('21.1 km')) {
          distances.push('21.1 km')
          seen.add('21.1 km')
        }
        // Time durations
        const hourMatch = text.match(/^(\d{1,2})\s*[hH]\b/)
        if (hourMatch) {
          const label = `${parseInt(hourMatch[1])}h`
          if (!seen.has(label)) { distances.push(label); seen.add(label) }
        }
      })
    })

    // Regulamin — event-specific PDFs (not portal regulamin)
    const regulaminUrls = []
    $('li.list-group-item-info').each((_, header) => {
      if (!$(header).text().trim().match(/^Regulamin$/)) return
      const regList = $(header).closest('ul.list-group')
      regList.find('a[href*="download/"]').each((_, a) => {
        const href = $(a).attr('href')
        if (href) {
          regulaminUrls.push(href.startsWith('http') ? href : `${BASE_URL}/${href}`)
        }
      })
    })

    // External links from description content — look for links to known sources
    // or event's own website
    let externalWebsite = null
    const contentDiv = $('div[style*="padding:10px"]').first()
    if (contentDiv.length) {
      contentDiv.find('a[href^="http"]').each((_, a) => {
        const href = $(a).attr('href')
        if (!href || externalWebsite) return
        // Skip social media, tracking pixels, etc.
        if (/facebook\.com|twitter\.com|instagram\.com|tpay\.com|fasttony\.com/i.test(href)) return
        externalWebsite = href
      })
    }

    return {
      name: name || null,
      location,
      date,
      distances: distances.join(', '),
      regulaminUrls,
      externalWebsite,
    }
  } catch (err) {
    console.error(`[elektronicznezapisy] Detail fetch failed for event ${eventId}:`, err.message)
    return null
  }
}

async function fetchSignupPageLinks(eventId) {
  try {
    const url = `${BASE_URL}/event/${eventId}/signup.html`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    // Find external links in signup page content
    let externalLink = null
    $('a[href^="http"]').each((_, a) => {
      const href = $(a).attr('href')
      if (!href || externalLink) return
      if (/elektronicznezapisy|google|facebook|twitter|instagram|tpay|fasttony|recaptcha|pixel|googleapis|gtm|cloudflare|jquery/i.test(href)) return
      externalLink = href
    })

    return externalLink
  } catch {
    return null
  }
}

async function scrape() {
  // Step 1: collect event IDs + basic data from listing pages
  const eventEntries = []

  for (const category of CATEGORY_URLS) {
    try {
      const res = await fetch(category.url, {
        headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
      })
      const html = await res.text()
      const $ = cheerio.load(html)

      $('tr').each((_, el) => {
        const cells = $(el).find('td')
        if (cells.length < 4) return

        const nameCell = $(cells[1])
        const href = nameCell.find('a').first().attr('href')

        const dateText = $(cells[2]).text().trim()
        const dateMatch = dateText.match(/(\d{4}-\d{2}-\d{2})/)
        const date = dateMatch ? dateMatch[1] : null

        if (!href || !date) return

        const idMatch = href.match(/event\/(\d+)/)
        if (!idMatch) return

        const signupLink = $(el).find('a[href*="signup"]').attr('href')

        eventEntries.push({
          eventId: idMatch[1],
          date,
          signupLink,
          categoryUrl: category.url,
        })
      })
    } catch (err) {
      console.error(`[elektronicznezapisy] Listing scrape failed for ${category.url}:`, err.message)
    }
  }

  console.log(`[elektronicznezapisy] Found ${eventEntries.length} events in listings, fetching details...`)

  // Step 2: fetch detail pages for clean data
  const results = []

  for (const entry of eventEntries) {
    const detail = await fetchDetailPage(entry.eventId)

    if (detail && detail.name) {
      // If description links to a known source, save the link but skip further processing
      const knownSourceLink = detail.externalWebsite && isKnownSourceUrl(detail.externalWebsite)
        ? detail.externalWebsite
        : null

      results.push({
        name: detail.name,
        date: detail.date || entry.date,
        location: detail.location || '',
        distances: detail.distances || '',
        registration_url: entry.signupLink
          ? `${BASE_URL}/${entry.signupLink}`
          : `${BASE_URL}/event/${entry.eventId}/strona.html`,
        regulamin_urls: detail.regulaminUrls || [],
        external_website: detail.externalWebsite || null,
        known_source_link: knownSourceLink,
        source: 'elektronicznezapisy',
        source_url: entry.categoryUrl,
        source_id: entry.eventId,
      })
    }

    // Rate limit: 1 req/sec
    await new Promise(r => setTimeout(r, 1100))
  }

  console.log(`[elektronicznezapisy] Scraped ${results.length} events with details`)
  return results
}

export { scrape }
