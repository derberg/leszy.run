import * as cheerio from 'cheerio'
import { fetchClassifications, parseClassifications } from './dostartu.js'

const BASE_URL = 'https://elektronicznezapisy.pl'
const DOSTARTU_API = 'https://api.dostartu.pl'

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
  'timekeeper.pl',
  'competitions.timekeeper.pl',
]

// Domains that use the dostartu API (same -v{id} URL pattern, same API at api.dostartu.pl)
const DOSTARTU_LIKE_DOMAINS = [
  'dostartu.pl',
  'zapisy.mktime.pl',
  'zapisy.o-timing.pl',
]

function isKnownSourceUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return KNOWN_SOURCE_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`))
  } catch {
    return false
  }
}

function isDostartuLikeUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return DOSTARTU_LIKE_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`))
  } catch {
    return false
  }
}

function extractDostartuId(url) {
  const match = url.match(/-v(\d+)/)
  return match ? match[1] : null
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
        const kmMatch = text.match(/(\d+[.,]?\d*)\s*km/i)
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
        const hourMatch = text.match(/(\d{1,2})\s*[hH]\b/)
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

// Enrich sparse events from dostartu-like APIs (dostartu.pl, zapisy.mktime.pl, etc.)
async function enrichFromDostartuApi(competitionId, eventName) {
  try {
    const res = await fetch(`${DOSTARTU_API}/competitions/${competitionId}`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) return null
    const json = await res.json()
    const comp = json.competition
    if (!comp) return null

    const classifications = await fetchClassifications(competitionId)
    const { distances } = parseClassifications(classifications, eventName)

    return {
      location: comp.location || null,
      lat: comp.locationLat || null,
      lng: comp.locationLng || null,
      distances,
    }
  } catch (err) {
    console.error(`[elektronicznezapisy] dostartu API enrichment failed for ${competitionId}:`, err.message)
    return null
  }
}

async function scrape({ knownIds = new Set() } = {}) {
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

  // Dedup by eventId — same event can appear in multiple category pages
  const seenIds = new Set()
  const uniqueEntries = eventEntries.filter(e => {
    if (seenIds.has(e.eventId)) return false
    seenIds.add(e.eventId)
    return true
  })
  const newEntries = uniqueEntries.filter(e => !knownIds.has(e.eventId))
  console.log(`[elektronicznezapisy] Found ${eventEntries.length} events (${eventEntries.length - uniqueEntries.length} cross-category dupes), ${newEntries.length} new (skipping ${uniqueEntries.length - newEntries.length} known)`)

  // Step 2: fetch detail pages only for new events
  const results = []

  for (const entry of newEntries) {
    const detail = await fetchDetailPage(entry.eventId)

    if (detail && detail.name) {
      const isSparse = !detail.distances

      // If detail page is sparse, check signup page for external registration link
      let signupExternalLink = null
      if (isSparse) {
        signupExternalLink = await fetchSignupPageLinks(entry.eventId)
        if (signupExternalLink) {
          console.log(`[elektronicznezapisy] Signup page redirect: ${entry.eventId} → ${signupExternalLink}`)
          await new Promise(r => setTimeout(r, 1100))
        }
      }

      const externalWebsite = detail.externalWebsite || signupExternalLink || null

      // If description links to a known source, save the link but skip further processing
      const knownSourceLink = externalWebsite && isKnownSourceUrl(externalWebsite)
        ? externalWebsite
        : null

      // Enrich from dostartu API if external link is dostartu-like and data is sparse
      let enriched = null
      if (isSparse && externalWebsite && isDostartuLikeUrl(externalWebsite)) {
        const compId = extractDostartuId(externalWebsite)
        if (compId) {
          enriched = await enrichFromDostartuApi(compId, detail.name)
          if (enriched) {
            console.log(`[elektronicznezapisy] Enriched ${entry.eventId} from dostartu API (comp ${compId}): distances=${enriched.distances}`)
          }
          await new Promise(r => setTimeout(r, 500))
        }
      }

      results.push({
        name: detail.name,
        date: detail.date || entry.date,
        location: enriched?.location || detail.location || '',
        distances: enriched?.distances || detail.distances || '',
        registration_url: signupExternalLink || (entry.signupLink
          ? `${BASE_URL}/${entry.signupLink}`
          : `${BASE_URL}/event/${entry.eventId}/strona.html`),
        regulamin_urls: detail.regulaminUrls || [],
        external_website: externalWebsite,
        known_source_link: knownSourceLink,
        source: 'elektronicznezapisy',
        source_url: `${BASE_URL}/event/${entry.eventId}/strona.html`,
        source_id: entry.eventId,
      })
    }

    console.log(`[elektronicznezapisy] Detail pages: ${results.length}/${newEntries.length} — ${detail?.name || entry.eventId}`)

    // Rate limit: 1 req/sec
    await new Promise(r => setTimeout(r, 1100))
  }

  console.log(`[elektronicznezapisy] Scraped ${results.length} events with details`)
  return results
}

export { scrape }
