import * as cheerio from 'cheerio'

const BASE_URL = 'https://competitions.timekeeper.pl'

// Polish month names (genitive) used on the listing page
const POLISH_MONTHS = {
  stycznia: '01', lutego: '02', marca: '03', kwietnia: '04',
  maja: '05', czerwca: '06', lipca: '07', sierpnia: '08',
  wrzesnia: '09', września: '09', pazdziernika: '10', października: '10',
  listopada: '11', grudnia: '12',
}

// Skip non-running events (cycling, MTB, etc.)
const SKIP_KEYWORDS = /\b(mtb|rowerow|kolarsk|rowerowa|rowerowy|rowerowe|kolarski|kolarska|kolarskie)\b/i

function isNonRunningEvent(name) {
  return SKIP_KEYWORDS.test(name)
}

// competitions.timekeeper.pl renders every "card value" twice — a desktop copy
// (`d-none d-lg-block`, 28px) and a mobile copy (`d-block d-lg-none`, 18px) — so a
// cheerio collection's .text() concatenates BOTH, yielding
// "Posada Zarszyńska\n                            Posada Zarszyńska".
// Always take .first() and collapse the newline/indent runs the template leaves behind.
function cardText(selection) {
  if (!selection.length) return null
  return selection.first().text().replace(/\s+/g, ' ').trim() || null
}

// A price cell reads "Bezpłatnie" when the start is free and "90.00 zł" when it is not.
// On a promotion it carries two figures — <del>80.00 zł</del> beside the 70.00 zł actually
// charged — and the struck-out one is not a price anyone pays, so it goes before we read.
// Anything else ("wg regulaminu", an empty cell) is no statement about the fee: null.
function parsePriceCell(cell) {
  if (!cell.length) return null
  const copy = cell.clone()
  copy.find('del').remove()
  const text = copy.text().replace(/\s+/g, ' ').trim()
  if (/bezp[łl]atn|darmow|gratis/i.test(text)) return 0
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(?:z[łl]|pln)/i)
  return match ? parseFloat(match[1].replace(',', '.')) : null
}

function parseListingDate(dayStr, monthStr) {
  if (!dayStr || !monthStr) return null
  const month = POLISH_MONTHS[monthStr.toLowerCase()]
  if (!month) return null
  const day = dayStr.padStart(2, '0')
  const year = new Date().getFullYear()
  return `${year}-${month}-${day}`
}

function parseDetailPage(html) {
  const $ = cheerio.load(html)

  // Date: p.text-primary.h3 with font-family Oxanium under "Data zawodow" heading
  let date = null
  $('h5, h6, strong').each((_, el) => {
    const text = $(el).text().trim()
    if (/data zawod/i.test(text)) {
      const card = $(el).closest('.card, .col, div')
      const dateText = cardText(card.find('p.text-primary.h3'))
      if (dateText) {
        const match = dateText.match(/(\d{4})-(\d{2})-(\d{2})/)
        if (match) date = match[0]
      }
    }
  })

  // Location: p.text-primary.h3 under "Lokalizacja" heading
  let location = null
  $('h5, h6, strong').each((_, el) => {
    const text = $(el).text().trim()
    if (/lokalizacja/i.test(text)) {
      const card = $(el).closest('.card, .col, div')
      location = cardText(card.find('p.text-primary.h3'))
    }
  })

  // Prices: one `.row` per start inside the "Koszt uczestnictwa" card, the start's
  // h6.font-weight-bolder.m-0 label and the fee in the `.text-right` cell beside it.
  // That heading is an <h4> in the card-header, so it needs both a wider tag match and
  // `.closest('.card')` — the nearest wrapping div is the header's own column, which
  // holds the heading and nothing else.
  //
  // The label is NOT a distance and is deliberately not emitted. Across the 20 live
  // pages on 2026-10-01 it reads "Bieg Niepodległości +grawerowanie medalu",
  // "Klasa 4x4 Weteran", "PRZYMIERZE [PRZemyśl - RZEszów, 130+ km] (pakiet z koszulką 🎽)"
  // and "Sztafeta rodzinna (rodzic + dziecko) - RODZIC WPISUJE TYLKO DANE STARTUJĄCEGO
  // DZIECKA" — ticket names, sometimes repeated, several carrying the comma that the
  // scraper_all → calendar_events step splits on. timekeeper is priority 3, so emitting
  // them would overwrite real distances that better sources already published.
  const prices = []
  $('h4, h5, h6, strong').each((_, el) => {
    const text = $(el).text().trim()
    if (/koszt uczestnictwa/i.test(text)) {
      const closestCard = $(el).closest('.card')
      const card = closestCard.length ? closestCard : $(el).closest('.col, div')
      card.find('h6.font-weight-bolder.m-0').each((_, h6) => {
        const price = parsePriceCell($(h6).closest('.row').find('.text-right').first())
        if (price !== null) prices.push(price)
      })
    }
  })

  // A free start beside a paid one must not drag price_from to 0 — the race costs money.
  // Only a card where every start is free reports 0. min/max also make the reading immune
  // to a cost card the template happens to render twice: repeating a figure cannot move
  // either end of the range.
  const paid = prices.filter(p => p > 0)
  const quoted = paid.length ? paid : prices
  const priceFrom = quoted.length ? Math.min(...quoted) : null
  const priceTo = quoted.length ? Math.max(...quoted) : null

  // Regulamin: a.btn.btn-success with href containing /download/
  let regulaminUrl = null
  const regLink = $('a.btn.btn-success[href*="/download/"]').first()
  if (regLink.length) {
    const href = regLink.attr('href')
    regulaminUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`
  }

  // Organizer website: link inside "Organizator zawodow" card body
  let website = null
  $('h5, h6, strong').each((_, el) => {
    const text = $(el).text().trim()
    if (/organizator zawod/i.test(text)) {
      const card = $(el).closest('.card, .col, div')
      const link = card.find('a[href^="http"]').first()
      if (link.length) {
        website = link.attr('href')
      }
    }
  })

  return {
    date,
    location,
    priceFrom,
    priceTo,
    regulaminUrl,
    website,
  }
}

async function fetchDetailPage(slug) {
  try {
    const url = `${BASE_URL}/${slug}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    return parseDetailPage(html)
  } catch (err) {
    console.error(`[timekeeper] Detail fetch failed for ${slug}:`, err.message)
    return null
  }
}

async function scrape({ knownIds = new Set() } = {}) {
  const eventEntries = []

  // Step 1: fetch listing page
  try {
    const res = await fetch(BASE_URL, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    $('section.container div.row.py-4.border-bottom').each((_, el) => {
      const row = $(el)

      // Event name: first <a> with meaningful href inside the row
      // Prefer the desktop variant (d-none d-md-block) with font-size 28px
      let name = null
      let href = null

      // Try desktop variant first
      const desktopDiv = row.find('div.d-none.d-md-block')
      if (desktopDiv.length) {
        const link = desktopDiv.find('a').first()
        if (link.length) {
          name = link.text().trim()
          href = link.attr('href')
        }
      }

      // Fallback: find first <a> with a meaningful path
      if (!name) {
        row.find('a[href]').each((_, a) => {
          if (name) return
          const h = $(a).attr('href')
          if (h && h !== '#' && !h.startsWith('http') && h !== '/') {
            name = $(a).text().trim()
            href = h
          }
        })
      }

      if (!name || !href) return

      // Skip non-running events (cycling, MTB, etc.)
      if (isNonRunningEvent(name)) return

      // "Więcej informacji" button determines internal vs external
      const moreInfoBtn = row.find('a.btn.btn-primary.btn-block')
      let btnHref = href
      if (moreInfoBtn.length) {
        btnHref = moreInfoBtn.attr('href')
      }

      // Skip external events (href starts with http)
      if (btnHref && btnHref.startsWith('http')) return

      // Date fallback from listing: day number in <h2>, Polish month in div.miesiac
      let listingDate = null
      const dateCol = row.find('div.data.text-center')
      if (dateCol.length) {
        const dayStr = dateCol.find('h2').text().trim()
        const monthDivs = dateCol.find('div.miesiac')
        const monthStr = monthDivs.first().text().trim()
        listingDate = parseListingDate(dayStr, monthStr)
      }

      // Location: div.text-danger with font-size 20px
      let location = null
      row.find('div.text-danger').each((_, el) => {
        const style = $(el).attr('style') || ''
        if (style.includes('20px') || !location) {
          location = $(el).text().replace(/\s+/g, ' ').trim() || null
        }
      })

      // Extract slug from href (strip leading /)
      const slug = btnHref.replace(/^\//, '')

      if (slug) {
        eventEntries.push({ name, slug, location, listingDate })
      }
    })
  } catch (err) {
    console.error(`[timekeeper] Listing scrape failed:`, err.message)
    return []
  }

  const newEntries = eventEntries.filter(e => !knownIds.has(e.slug))
  console.log(`[timekeeper] Found ${eventEntries.length} events, ${newEntries.length} new (skipping ${eventEntries.length - newEntries.length} known)`)

  // Step 2: fetch detail pages for new events
  const results = []

  for (const entry of newEntries) {
    const detail = await fetchDetailPage(entry.slug)

    const event = {
      name: entry.name,
      date: detail?.date || entry.listingDate || null,
      location: detail?.location || entry.location || '',
      // Neither the listing nor the detail page states a distance — see parseDetailPage
      // on why the cost card's start labels are not one. Stays empty, as it always was.
      distances: '',
      price_from: detail?.priceFrom ?? null,
      price_to: detail?.priceTo ?? null,
      registration_url: `${BASE_URL}/${entry.slug}`,
      regulamin_url: detail?.regulaminUrl || null,
      website: detail?.website || null,
      source: 'timekeeper',
      source_id: entry.slug,
      source_url: `${BASE_URL}/${entry.slug}`,
    }

    results.push(event)

    console.log(`[timekeeper] Detail pages: ${results.length}/${newEntries.length} — ${entry.name}`)

    // Rate limit: 1 req/sec
    await new Promise(r => setTimeout(r, 1100))
  }

  console.log(`[timekeeper] Scraped ${results.length} events`)
  return results
}

export { scrape, parseDetailPage }
