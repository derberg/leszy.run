import * as cheerio from 'cheerio'

const BASE_URL = 'https://liveds.datasport.pl'
const LIST_URL = `${BASE_URL}/lista.html`

// The number a race category name carries: kilometres ("Bieg 10km", "Bieg 5 km")
// or a duration ("Bieg 4h", "Bieg 6H"). Digits only, so it holds whatever the
// Polish letters around them look like.
function readDistanceDigits(text, distances) {
  // Extract km from heading like "Bieg 10km", "Bieg 5 km", "Półmaraton"
  const kmMatch = text.match(/(\d+[.,]?\d*)\s*km/i)
  if (kmMatch) {
    const km = parseFloat(kmMatch[1].replace(',', '.'))
    const label = `${km} km`
    if (km > 0 && km < 500 && !distances.includes(label)) distances.push(label)
  }
  // Time-based durations (e.g., "Bieg 4h", "Bieg 6H")
  const hourMatch = text.match(/\b(\d{1,2})\s*[hH]\b/)
  if (hourMatch) {
    const hours = parseInt(hourMatch[1])
    const label = `${hours}h`
    if (hours > 0 && hours <= 48 && !distances.includes(label)) distances.push(label)
  }
}

// A heading, where a distance may also be spelled out as a word.
function readDistanceHeading(text, distances) {
  readDistanceDigits(text, distances)
  // Named distances
  if (/półmaraton|polmaraton/i.test(text) && !distances.some(d => d.includes('21'))) {
    distances.push('21.1 km')
  }
  if (/\bmaraton\b/i.test(text) && !/pół|pol/i.test(text) && !distances.some(d => d.includes('42'))) {
    distances.push('42.2 km')
  }
}

// Race categories as the stats page reads them. The JSON is UTF-8, unlike the
// windows-1250 event pages, so the default fetch decoding is the right one.
async function fetchStatsDistances(eventId) {
  try {
    const res = await fetch(`${BASE_URL}/statcont/statystyki${eventId}.json`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) return []

    const data = await res.json()
    const all = data && data.distances && data.distances.all
    return Array.isArray(all) ? all.map(d => d && d.name).filter(Boolean) : []
  } catch (err) {
    return []
  }
}

async function fetchDetailPage(eventId) {
  try {
    const url = `${BASE_URL}/zawody_files/zawody${eventId}.html`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) return null

    const buffer = await res.arrayBuffer()
    const html = new TextDecoder('windows-1250').decode(buffer)
    const $ = cheerio.load(html)

    // Extract distances from <h4> race category headings in the section after #features.
    // Structure: <section id="features">...</section> <section>...<h4>Bieg 10km</h4>...
    // These headings contain the actual race names with distances — no junk.
    const distances = []
    const featuresSection = $('section#features')
    const categorySection = featuresSection.next('section')
    const headings = categorySection.length ? categorySection.find('h4') : $('h4')

    headings.each((_, el) => readDistanceHeading($(el).text().trim(), distances))

    // Newer "Panel zapisów" pages carry no category headings at all: the
    // #features section holds generic cards only (results, signup, group signup,
    // list, stats). The categories are still published, but only in the JSON the
    // stats page fetches client-side. 25 BIEG MARATOŃCZYKA (12775, 2026-12-20)
    // is such a page — zero <h4>, while statystyki12775.json lists "Bieg 10km".
    //
    // Only the digits are read there. datasport mangles Polish letters in those
    // names — event 12557's "XI PÓŁMARATON PIASTOWSKI" arrives as "PӣMARATON",
    // which still matches /maraton/ but no longer matches /pół/, so the word
    // branch would publish 42.2 km for a half marathon. No distance beats a
    // wrong one.
    if (distances.length === 0) {
      const names = await fetchStatsDistances(eventId)
      for (const name of names) readDistanceDigits(name, distances)
    }

    // Regulamin PDF URL
    const regulaminLink = $(`a[href*="regulaminy/regulamin_${eventId}.pdf"]`).attr('href') || null

    return {
      distances: distances.join(', '),
      regulaminUrl: regulaminLink,
    }
  } catch (err) {
    return null
  }
}

// Should this listing entry have its detail page read?
//
// A known source_id is not a finished row. The rows scraped from a "Panel
// zapisów" page before the stats JSON was read have no distances, and skipping
// every known id meant the page was never opened again, so they stayed empty for
// good — 25 BIEG MARATOŃCZYKA (12775, 2026-12-20) among them. A stored future row
// with no distances is read again; a past race is left alone.
//
// knownRows comes from the raw table and is empty unless the source declares
// knownColumns, so a known id with no stored row keeps the old skip rather than
// re-fetching blind.
function needsDetail(entry, knownIds, knownRows, today) {
  if (!knownIds.has(entry.sourceId)) return true
  const known = knownRows.get(entry.sourceId)
  if (!known) return false
  return !known.distances && String(known.date) >= today
}

// Should this entry be written at all?
//
// fetchDetailPage returns null for ANY failure, and a re-scrape is authoritative
// for its own record, so a row emitted from a null detail overwrites the stored
// regulamin URL with null. The re-check set is exactly the rows waiting for
// distances, and some of them already carry a regulamin PDF, so one bad minute
// at the source would erase it. A known row whose detail page could not be read
// is left exactly as it is; a new row is still worth recording from the listing
// alone, since there is nothing there to lose.
function shouldEmitRow(detail, isKnown) {
  return detail !== null || !isKnown
}

async function scrape({ knownIds = new Set(), knownRows = new Map(), today } = {}) {
  const results = []
  const asOf = today || new Date().toISOString().split('T')[0]

  try {
    const res = await fetch(LIST_URL, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const buffer = await res.arrayBuffer()
    const html = new TextDecoder('windows-1250').decode(buffer)
    const $ = cheerio.load(html)

    const entries = []

    $('.event-list-box').each((_, el) => {
      const box = $(el)
      const nameLink = box.find('h5 a').first()
      const name = nameLink.text().trim()
      const href = nameLink.attr('href')

      const allText = box.text()
      const dateMatch = allText.match(/(\d{4}-\d{2}-\d{2})/)
      const date = dateMatch ? dateMatch[1] : null

      const location = box.find('li').first().text().trim()

      if (!name || !date) return

      const idMatch = href ? href.match(/zawody(\d+)/) : null
      const sourceId = idMatch ? idMatch[1] : `${name}-${date}`

      entries.push({
        name, date, location, sourceId,
        href: href ? (href.startsWith('http') ? href : `${BASE_URL}/${href}`) : null,
      })
    })

    const newEntries = entries.filter(e => needsDetail(e, knownIds, knownRows, asOf))
    const recheckCount = newEntries.filter(e => knownIds.has(e.sourceId)).length
    console.log(`[datasport] Found ${entries.length} events, ${newEntries.length - recheckCount} new, ${recheckCount} re-checked (skipping ${entries.length - newEntries.length} known)`)

    // Fetch detail pages only for new and re-checked events
    for (let i = 0; i < newEntries.length; i++) {
      const entry = newEntries[i]
      let distances = ''

      let regulaminUrl = null
      const detail = await fetchDetailPage(entry.sourceId)
      if (!shouldEmitRow(detail, knownIds.has(entry.sourceId))) {
        console.log(`[datasport] ${entry.sourceId}: detail page unreadable, keeping stored values`)
        await new Promise(r => setTimeout(r, 1100))
        continue
      }
      if (detail) {
        distances = detail.distances
        regulaminUrl = detail.regulaminUrl
      }

      // The exact URL datasport's own "Zapisz się na zawody" button uses on the
      // public event page. Goes through liveds.datasport.pl's anti-bot queue,
      // then to the per-race signup form (which itself enforces login).
      //
      // VERIFIED:
      //   1. scraped the public event page on 6 different competition IDs —
      //      same /queue/?redirect_url=… pattern every time
      //   2. user manually clicked through six concrete URLs and confirmed each
      //      lands on the right race's signup form (post-login)
      //
      // Two seemingly-cleaner alternatives both fail:
      //   online.datasport.pl/zapisy/portal/baza/wizardnew/?zawody=<id>  → 302 to login.php (race id stripped)
      //   online.datasport.pl/zapisy/portal/form/?zawody=<id>&co=form    → 302 to zaloguj.php (race id stripped)
      // The /queue/?redirect_url=… wrapper keeps the race id in a query param
      // that survives the auth round-trip.
      const formUrl = encodeURIComponent(`https://online.datasport.pl/zapisy/portal/form/?zawody=${entry.sourceId}&co=form`)
      const registrationUrl = `${BASE_URL}/queue/?redirect_url=${formUrl}`

      results.push({
        name: entry.name,
        date: entry.date,
        location: entry.location,
        distances,
        registration_url: registrationUrl,
        regulamin_url: regulaminUrl,
        source: 'datasport',
        source_url: `${BASE_URL}/zawody_files/zawody${entry.sourceId}.html`,
        source_id: entry.sourceId,
      })

      // Rate limit
      await new Promise(r => setTimeout(r, 1100))

      if ((i + 1) % 50 === 0) {
        console.log(`[datasport] Detail pages: ${i + 1}/${newEntries.length}`)
      }
    }

    console.log(`[datasport] Scraped ${results.length} events with details`)
  } catch (err) {
    console.error('[datasport] Scrape failed:', err.message)
  }

  return results
}

export { scrape, fetchDetailPage, needsDetail, shouldEmitRow }
