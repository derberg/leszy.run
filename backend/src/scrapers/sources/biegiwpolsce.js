import * as cheerio from 'cheerio'

const BASE_URL = 'https://www.biegiwpolsce.pl'

// Known scraper source domains — save the link but don't process further
const KNOWN_SOURCE_DOMAINS = [
  'maratonypolskie.pl',
  'datasport.pl',
  'liveds.datasport.pl',
  'online.datasport.pl',
  'elektronicznezapisy.pl',
  'dostartu.pl',
  'pomiarczasuatelier.pl',
]

// Tags that are distances, not event types
const DISTANCE_TAGS = {
  '5 km': '5 km',
  '10 km': '10 km',
  'Półmaraton': '21.1 km',
  'Maraton': '42.2 km',
  'Ultramaraton': 'ultra',
}

// Tags that indicate kids run
const KIDS_TAG = 'Dla dzieci'

function splitTags(tags) {
  const eventTypes = []
  const distances = []
  let isKids = false

  for (const tag of tags) {
    if (tag === KIDS_TAG) {
      isKids = true
      continue
    }
    if (DISTANCE_TAGS[tag]) {
      distances.push(DISTANCE_TAGS[tag])
    } else {
      eventTypes.push(tag)
    }
  }

  return { eventTypes, distances: distances.join(', '), isKids }
}

function isKnownSourceUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return KNOWN_SOURCE_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`))
  } catch {
    return false
  }
}

async function fetchDetailPage(path) {
  try {
    const url = `${BASE_URL}${path}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    // City + voivodeship from structured section:
    // <i class="fas fa-map-marker-alt text-green-500 mr-4"></i><strong>Rybnik</strong>, śląskie
    let city = null
    let voivodeship = null
    $('i.fa-map-marker-alt').each((_, el) => {
      const parent = $(el).parent()
      const strong = parent.find('strong')
      if (strong.length) {
        city = strong.text().trim()
        // Voivodeship is after the strong tag: ", śląskie"
        const fullText = parent.text().trim()
        const commaMatch = fullText.match(/,\s*([a-ząćęłńóśźż-]+)\s*$/i)
        if (commaMatch) voivodeship = commaMatch[1].trim()
      }
    })

    // Event types from tags:
    // <p class="... bg-gray-300 ...">Przełaj/Cross</p>
    // <p class="... bg-green-200 ...">Ultramaraton</p>
    const eventTypes = []
    $('i.fa-tags').closest('div').find('p').each((_, el) => {
      const tag = $(el).text().trim()
      if (tag && tag !== 'Inne') eventTypes.push(tag)
    })

    // Regulamin link from red button: div.text-red-700 a[href]
    const regulaminDiv = $('div.text-red-700')
    const regulaminUrl = regulaminDiv.find('a').attr('href') || null

    // Zapisy (registration) link from green button: div.text-green-700 a[href]
    const zapisyDiv = $('div.text-green-700')
    const registrationUrl = zapisyDiv.find('a').attr('href') || null

    // Check if registration URL is a known source
    const knownSourceLink = registrationUrl && isKnownSourceUrl(registrationUrl)
      ? registrationUrl
      : null

    return { city, voivodeship, eventTypes, regulaminUrl, registrationUrl, knownSourceLink }
  } catch (err) {
    return null
  }
}

async function scrape({ knownIds = new Set() } = {}) {
  const results = []
  let page = 1
  const maxPages = 10

  // Step 1: collect events from listing pages
  const eventEntries = []

  while (page <= maxPages) {
    try {
      const url = page === 1 ? BASE_URL : `${BASE_URL}/?page=${page}`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
      })
      const html = await res.text()
      const $ = cheerio.load(html)

      let foundOnPage = 0

      $('a[href]').each((_, el) => {
        const a = $(el)
        const h2 = a.find('h2')
        if (!h2.length) return

        const name = h2.text().trim()
        if (!name) return

        const href = a.attr('href')

        const dateDiv = a.find('.date, [class*="date"]')
        let dateText = dateDiv.length ? dateDiv.text().trim() : ''

        if (!dateText) {
          const allText = a.text()
          const dateSearch = allText.match(/(\d{2})\.(\d{2})\.(\d{4})/)
          if (dateSearch) dateText = dateSearch[0]
        }

        const dateMatch = dateText.match(/(\d{2})\.(\d{2})\.(\d{4})/)
        if (!dateMatch) return
        const date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`

        // Try to find pipe-separated line: "City | voivodeship | Type"
        let location = ''
        let voivodeship = ''
        a.find('p').each((_, p) => {
          const text = $(p).text().trim()
          if (text.includes('|') && text.split('|').length >= 2) {
            const parts = text.split('|').map(s => s.trim())
            if (parts[0].length < 30) {
              location = parts[0]
              voivodeship = parts[1] || ''
            }
          }
        })

        eventEntries.push({
          name,
          date,
          location,
          voivodeship,
          href,
        })

        foundOnPage++
      })

      if (foundOnPage === 0) break
      page++

      await new Promise(r => setTimeout(r, 1100))
    } catch (err) {
      console.error(`[biegiwpolsce] Listing scrape failed for page ${page}:`, err.message)
      break
    }
  }

  const newEntries = eventEntries.filter(e => {
    const sourceId = e.href || `${e.name}-${e.date}`
    return !knownIds.has(sourceId)
  })
  console.log(`[biegiwpolsce] Found ${eventEntries.length} events, ${newEntries.length} new (skipping ${eventEntries.length - newEntries.length} known)`)

  // Step 2: fetch detail pages only for new events
  for (const entry of newEntries) {
    let regulaminUrl = null
    let registrationUrl = null
    let knownSourceLink = null
    let detail = null

    if (entry.href) {
      detail = await fetchDetailPage(entry.href)
      if (detail) {
        if (detail.city) entry.location = detail.city
        if (detail.voivodeship) entry.voivodeship = detail.voivodeship
        regulaminUrl = detail.regulaminUrl
        registrationUrl = detail.registrationUrl
        knownSourceLink = detail.knownSourceLink
      }
      await new Promise(r => setTimeout(r, 1100))
    }

    const { eventTypes, distances, isKids } = splitTags(detail?.eventTypes || [])

    console.log(`[biegiwpolsce] Detail pages: ${results.length + 1}/${newEntries.length} — ${entry.name}`)

    results.push({
      name: entry.name,
      date: entry.date,
      location: entry.location,
      voivodeship: entry.voivodeship,
      distances,
      registration_url: registrationUrl,
      regulamin_url: regulaminUrl,
      event_types: eventTypes.length > 0 ? eventTypes : null,
      is_kids: isKids,
      known_source_link: knownSourceLink,
      source: 'biegiwpolsce',
      source_url: entry.href ? `${BASE_URL}${entry.href}` : BASE_URL,
      source_id: entry.href || `${entry.name}-${entry.date}`,
    })
  }

  console.log(`[biegiwpolsce] Scraped ${results.length} events`)
  return results
}

export { scrape }
