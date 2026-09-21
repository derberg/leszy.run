import * as cheerio from 'cheerio'
import { isDostartuLikeUrl, enrichFromUrl } from '../apiEnrich.js'

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
  'timekeeper.pl',
  'competitions.timekeeper.pl',
]

function isKnownSourceUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return KNOWN_SOURCE_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`))
  } catch {
    return false
  }
}

// Distances an organizer wrote into the description instead of the price list.
//
// The Cennik table is the structured answer and stays authoritative; this reads the
// prose only when that table yields nothing, which is the state of every event
// announced before registration opens. It is deliberately anchored rather than
// greedy: a description states the course as well as the races, and "2 km asfaltu",
// "300 m przewyższenia" and "dwie pętle – 2 km oraz 3 km" are not races. So a figure
// counts only when a race word introduces it, and only the first figure after that
// word is taken — everything further along the sentence describes it.
//
// Kilometres only. Kids races are published in metres ("100, 300, 500 metrów"), and
// those belong in is_kids, not in the distance list.
const RACE_WORD = /\b(bieg\w*|marsz\w*|dystans\w*|p[oó][lł]maraton\w*|maraton\w*|ultra\w*)/gi
// How far past the race word the figure may sit. A longer reach starts crossing into
// the next item of a numbered programme.
const FIGURE_REACH = 60
// One figure, or a list of them sharing a unit: "3 lub 6 km", "17,5 KM".
const FIGURE = /(\d+(?:[.,]\d+)?(?:\s*(?:lub|i|oraz|\/|,)\s*\d+(?:[.,]\d+)?)*)\s*km\b/i
// A kids race, not a mention of children. "biegi dla dzieci" and "biegi malucha"
// are races; "obok rodziców z dziećmi" is the crowd.
const KIDS_RACE = /(bieg\w*|marsz\w*)[^.]{0,30}?(dzieci|maluch\w*|junior\w*|m[lł]odzie[zż]\w*)/i

export function distancesFromDescription(text) {
  const prose = String(text || '').replace(/\s+/g, ' ')
  const distances = []
  const seen = new Set()

  RACE_WORD.lastIndex = 0
  let anchor
  while ((anchor = RACE_WORD.exec(prose)) !== null) {
    const window = prose.slice(anchor.index + anchor[0].length, anchor.index + anchor[0].length + FIGURE_REACH)
    const figure = window.match(FIGURE)
    if (!figure) continue
    // Read the numbers back out rather than splitting on the separators: a comma is
    // both of them at once, and splitting turned "17,5 km" into a 17 and a 5.
    for (const part of figure[1].match(/\d+(?:[.,]\d+)?/g) || []) {
      const km = parseFloat(part.replace(',', '.'))
      if (!(km > 0 && km < 500)) continue
      const label = `${km} km`
      if (seen.has(label)) continue
      distances.push(label)
      seen.add(label)
    }
  }

  return { distances, isKids: KIDS_RACE.test(prose) }
}

// Is this entry worth a detail fetch?
//
// A known source_id is not a finished row. elektronicznezapisy publishes the event
// page as soon as the organizer announces a date and opens the Cennik later, so a
// row first scraped in that window has no distances and no prices. Skipping every
// known id meant the page was never read again and those fields stayed empty for
// good: 16096 (VII Ultras Oliwski, 2027-09-18) lists its three distances in the
// description today and would never have been re-read.
//
// knownRows comes from the raw table and is empty unless the source declares
// knownColumns, so a known id with no stored row keeps the old skip rather than
// re-fetching blind. A past race is left alone — its Cennik is not going to open.
export function needsDetail(entry, knownIds, knownRows, today) {
  if (!knownIds.has(entry.eventId)) return true
  const known = knownRows.get(entry.eventId)
  if (!known) return false
  return !known.distances && String(known.date) >= today
}

export async function fetchDetailPage(eventId) {
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

    // Date and registration deadline from list items
    let date = null
    let deadline = null
    $('li.list-group-item').each((_, el) => {
      const text = $(el).text().trim()
      const startMatch = text.match(/Początek imprezy:\s*(\d{4})[.\-](\d{2})[.\-](\d{2})/)
      if (startMatch && !date) {
        date = `${startMatch[1]}-${startMatch[2]}-${startMatch[3]}`
      }
      const deadlineMatch = text.match(/Zamknięcie rejestracji:\s*(\d{4})[.\-](\d{2})[.\-](\d{2})/)
      if (deadlineMatch && !deadline) {
        deadline = `${deadlineMatch[1]}-${deadlineMatch[2]}-${deadlineMatch[3]}`
      }
    })
    // Fallback: any YYYY.MM.DD / YYYY-MM-DD in body
    if (!date) {
      const bodyText = $('body').text()
      const dateMatch = bodyText.match(/(\d{4})[.\-](\d{2})[.\-](\d{2})/)
      if (dateMatch) date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
    }

    // Distances and prices from Cennik / Opłaty startowe section.
    // Iterates rows: first td = category name (distances + kids), second td = price.
    const distances = []
    const seen = new Set()
    const prices = []
    let isKids = false
    $('li.list-group-item-info').each((_, header) => {
      const headerText = $(header).text().trim()
      if (headerText !== 'Cennik' && headerText !== 'Opłaty startowe') return
      const cennikList = $(header).closest('ul.list-group')
      cennikList.find('tr').each((_, tr) => {
        const cells = $(tr).find('td')
        if (cells.length < 2) return
        const name = $(cells[0]).text().trim()
        const priceText = $(cells[1]).text().trim()

        // Distances from category name
        const kmMatch = name.match(/(\d+[.,]?\d*)\s*km/i)
        if (kmMatch) {
          const km = parseFloat(kmMatch[1].replace(',', '.'))
          const label = `${km} km`
          if (km > 0 && km < 500 && !seen.has(label)) {
            distances.push(label)
            seen.add(label)
          }
        }
        if (/półmaraton|polmaraton/i.test(name) && !seen.has('21.1 km')) {
          distances.push('21.1 km')
          seen.add('21.1 km')
        }
        const hourMatch = name.match(/(\d{1,2})\s*[hH]\b/)
        if (hourMatch) {
          const label = `${parseInt(hourMatch[1])}h`
          if (!seen.has(label)) { distances.push(label); seen.add(label) }
        }

        // Kids detection from category name
        if (/dzieci|junior|maluch|młodzież|mlodzież/i.test(name)) isKids = true

        // Price from second cell
        const priceMatch = priceText.match(/(\d+(?:[.,]\d+)?)\s*PLN/i)
        if (priceMatch) prices.push(parseFloat(priceMatch[1].replace(',', '.')))
      })
    })

    // Description — the event's own text, and the only place a distance appears
    // before the organizer opens the price list.
    const contentDiv = $('div[style*="padding:10px"]').first()

    // Cennik yielded nothing: read the description instead. Only in that branch —
    // a price table that names its races has already answered, and the prose of the
    // same event tends to round ("półmaraton na dystansie około 21 km" against the
    // Cennik's 21.1).
    if (distances.length === 0 && contentDiv.length) {
      const fromProse = distancesFromDescription(contentDiv.text())
      distances.push(...fromProse.distances)
      if (fromProse.isKids) isKids = true
    }

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
      price_from: prices.length ? Math.round(Math.min(...prices)) : null,
      price_to: prices.length ? Math.round(Math.max(...prices)) : null,
      registration_deadline: deadline,
      is_kids: isKids,
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


async function scrape({ knownIds = new Set(), knownRows = new Map(), today } = {}) {
  const asOf = today || new Date().toISOString().slice(0, 10)
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
  const newEntries = uniqueEntries.filter(e => needsDetail(e, knownIds, knownRows, asOf))
  const recheck = newEntries.filter(e => knownIds.has(e.eventId)).length
  console.log(`[elektronicznezapisy] Found ${eventEntries.length} events (${eventEntries.length - uniqueEntries.length} cross-category dupes), ${newEntries.length - recheck} new, ${recheck} re-checked for missing distances (skipping ${uniqueEntries.length - newEntries.length} known)`)

  // Step 2: fetch detail pages only for new events
  const results = []

  for (const entry of newEntries) {
    const detail = await fetchDetailPage(entry.eventId)

    if (detail && detail.name) {
      // If detail page is sparse, check signup page for external registration link
      let signupExternalLink = null
      if (!detail.distances) {
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

      // Enrich from dostartu-like API if external link is a dostartu-compatible platform.
      // This covers cases where externalWebsite is dostartu but registration_url is EZ —
      // index.js-level enrichment won't see the dostartu URL in those cases.
      let apiData = {}
      if (externalWebsite && isDostartuLikeUrl(externalWebsite)) {
        const enriched = await enrichFromUrl({ registration_url: externalWebsite, name: detail.name })
        apiData = enriched
        console.log(`[elektronicznezapisy] API-enriched ${entry.eventId}: distances=${apiData.distances}, price_from=${apiData.price_from}, deadline=${apiData.registration_deadline}`)
        await new Promise(r => setTimeout(r, 500))
      }

      results.push({
        name: detail.name,
        date: detail.date || entry.date,
        location: apiData.location || detail.location || '',
        lat: apiData.lat ?? null,
        lng: apiData.lng ?? null,
        distances: apiData.distances || detail.distances || '',
        registration_url: signupExternalLink || (entry.signupLink
          ? `${BASE_URL}/${entry.signupLink}`
          : `${BASE_URL}/event/${entry.eventId}/strona.html`),
        regulamin_urls: detail.regulaminUrls || [],
        regulamin_url: apiData.regulamin_url || null,
        external_website: externalWebsite,
        known_source_link: knownSourceLink,
        price_from: detail.price_from ?? apiData.price_from,
        price_to: detail.price_to ?? apiData.price_to,
        registration_deadline: detail.registration_deadline || apiData.registration_deadline,
        website: apiData.website || null,
        is_kids: detail.is_kids || apiData.is_kids || false,
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
