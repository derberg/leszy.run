import * as cheerio from 'cheerio'
import { pickRegulaminFromDom } from '../../lib/pickRegulaminUrl.js'

const BASE_URL = 'https://www.zmierzymyczas.pl'

// zmierzymyczas's "Miejsce" cell is a free-text venue string, not a city: the town
// is usually followed by the venue/street ("Krasiejów, Park Nauki i Rozrywki ul. 1
// Maja 10", "Prószków (Stadion Miejski, ul. Sportowa 3)"). Geocoding and the public
// kalendarz both want the bare town, so peel the qualifier off — but ONLY when the
// leading segment is unambiguously a bare place name. Plenty of rows put the venue
// FIRST ("Przystań kajakowa „Amazonka”, Staniszcze Wielkie", "Park Szczodre, Stawowa
// 6"); truncating those would throw the town away, so they are left verbatim for the
// geocoder/enricher to deal with.
// NOTE the \p{L} boundaries instead of \b: JS's \b is ASCII-only, so /\bprzystań\b/
// never matches ("ń" is not \w, so there is no word boundary after it) — which is
// exactly the case ("Przystań kajakowa „Amazonka”, Staniszcze Wielkie") where the
// venue comes first and truncating would discard the town.
const VENUE_WORDS = /(?<!\p{L})(stadion|park|hala|boisko|osrodek|ośrodek|osw|zamek|jezioro|zalew|staw|dolina|przystań|przystan|plaża|plaza|kopalnia|szkoła|szkola|klub|arena|strefa|centrum|amfiteatr|molo|rynek|ul\.|ulica|al\.|aleja|pl\.|plac)(?!\p{L})/iu

function looksLikeBareTown(segment) {
  if (!segment) return false
  if (/\d/.test(segment)) return false            // house numbers, "Dolina 3 Stawów"
  if (VENUE_WORDS.test(segment)) return false     // venue named before the town
  return segment.split(/\s+/).length <= 3         // "Staniszcze Wielkie" ok, prose not
}

function cityFromVenue(location) {
  if (!location) return null
  const clean = location.replace(/\s+/g, ' ').trim()
  if (!clean) return null
  // "Prószków (Stadion Miejski, ul. Sportowa 3)" / "Kup (obok boiska LZS Kup, ...)"
  const parened = clean.split('(')[0].trim()
  if (parened !== clean && looksLikeBareTown(parened)) return parened
  // "Krasiejów, Park Nauki i Rozrywki ul. 1 Maja 10"
  const comma = clean.split(',')[0].trim()
  if (comma !== clean && looksLikeBareTown(comma)) return comma
  // "Wrocław - Park Południowy" / "Zagwiździe – teren kompleksu ...". Spaces around
  // the dash are required so hyphenated towns (Jelcz-Laskowice, Kędzierzyn-Koźle)
  // are never split.
  const dashed = clean.split(/ [-–—] /)[0].trim()
  if (dashed !== clean && looksLikeBareTown(dashed)) return dashed
  return clean
}

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
    //
    // zmierzymyczas publishes SEVERAL documents per event under that same path:
    // the regulamin plus oświadczenie/zgoda consent forms, and sometimes a
    // course map. This used to keep the LAST match, and since the regulamin is
    // linked first and the consent forms after it, the consent form won every
    // time — 19 rows in scraper_all carried one as their regulamin, which then
    // fed the enricher a document with no fee, no deadline and no distances.
    // pickRegulaminUrl requires positive "regulamin" evidence instead of
    // relying on link order.
    const regulaminUrl = pickRegulaminFromDom($, {
      selector: 'a[href*="/images/regulaminy/"]',
      baseUrl: BASE_URL,
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

// Is this listing entry's detail page worth fetching on this run?
//
// A known source_id is not a finished row. zmierzymyczas publishes the event page
// first and opens registration later — until then the page says "Zapisy zostaną
// otwarte <date> o <time>" and carries no /edit/ link at all, so the first scrape
// correctly stores registration_url null. Skipping every known id meant that page
// was never read again and the link that appeared hours later was never picked up:
// 12 future-dated rows sit at null today, one of them (2664, XIX ZIMNAR, 2027-01-10)
// with a live /edit/ link on the page right now.
//
// knownRows comes from the raw table. A known id with no row there (a source that
// does not declare knownColumns) keeps the old skip rather than re-fetching blind.
// A past race is left alone — its registration is not going to open.
function needsDetail(entry, knownIds, knownRows, today) {
  if (!knownIds.has(entry.sourceId)) return true
  const known = knownRows.get(entry.sourceId)
  if (!known) return false
  return !known.registration_url && String(known.date) >= today
}

async function scrape({ knownIds = new Set(), knownRows = new Map() } = {}) {
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

      entries.push({ name, date, distances, location: cityFromVenue(location), href, sourceId })
    })

    const today = new Date().toISOString().slice(0, 10)
    const dueEntries = entries.filter(e => needsDetail(e, knownIds, knownRows, today))
    const recheckCount = dueEntries.filter(e => knownIds.has(e.sourceId)).length
    console.log(`[zmierzymyczas] Found ${entries.length} events, ${dueEntries.length - recheckCount} new, ${recheckCount} re-checked (skipping ${entries.length - dueEntries.length} known)`)

    for (let i = 0; i < dueEntries.length; i++) {
      const entry = dueEntries[i]

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
        console.log(`[zmierzymyczas] Detail pages: ${i + 1}/${dueEntries.length}`)
      }
    }

    console.log(`[zmierzymyczas] Scraped ${results.length} events with details`)
  } catch (err) {
    console.error('[zmierzymyczas] Scrape failed:', err.message)
  }

  return results
}

export { scrape, needsDetail }
