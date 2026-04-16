import * as cheerio from 'cheerio'

const BASE_URL = 'https://b4sportonline.pl'
const LIST_URL = `${BASE_URL}/kalendarz/`

// Polish genitive month names as they appear in card dates, e.g. "18 Kwietnia 2026"
const POLISH_MONTHS = {
  stycznia: '01', lutego: '02', marca: '03', kwietnia: '04',
  maja: '05', czerwca: '06', lipca: '07', sierpnia: '08',
  wrzesnia: '09', września: '09', pazdziernika: '10', października: '10',
  listopada: '11', grudnia: '12',
}

// Non-running events (b4sport hosts bike races, triathlons, etc. alongside running).
// Keep trail, gorski, ultra, nordic walking, OCR, road running — filter out obvious non-running.
const SKIP_KEYWORDS = /\b(mtb|rowerow[aey]?|kolarsk[aie]?|kolarski|rajd rowerowy|triathlon|duathlon|bike race|bike|aquathlon)\b/i

function parseCardDate(raw) {
  if (!raw) return null
  // e.g. " 18 Kwietnia 2026"
  const m = raw.trim().match(/^(\d{1,2})\s+([A-Za-zĄąĆćĘęŁłŃńÓóŚśŹźŻż]+)\s+(\d{4})$/)
  if (!m) return null
  const day = m[1].padStart(2, '0')
  const monthKey = m[2].toLowerCase()
  const month = POLISH_MONTHS[monthKey]
  if (!month) return null
  return `${m[3]}-${month}-${day}`
}

function extractNumericId(url) {
  if (!url) return null
  const m = url.match(/\/(\d+)(?:[/?#]|$)/)
  return m ? m[1] : null
}

// Extract distances from multi-distance child list items.
// Examples: "7 Bieg Korczaka - bieg 5km", "Po Grudzie Bike Race 2026" (parent) + "zapisy_na_dystans_100km" (child),
// "dzieci__kat_810_lat_20182016__dystans_ok_400m".
function extractDistancesFromChildren($, listEl) {
  const dists = new Set()
  listEl.find('li').each((_, li) => {
    // Only use visible text, NOT href — URL slugs concatenate numbers (e.g. "1012km" = "10-12km")
    const text = $(li).text()
    // Match "5km", "21.0975km", "400m", "10 km", "5 K" — normalize to lowercase with units
    const matches = text.matchAll(/(\d+(?:[.,]\d+)?)\s*(km|m)\b/gi)
    for (const mm of matches) {
      const num = mm[1].replace(',', '.')
      const unit = mm[2].toLowerCase()
      // Ignore bare years (1998, 2025) and category-age tokens that caught on "m"
      if (unit === 'm' && parseFloat(num) > 1000) continue
      dists.add(`${num}${unit}`)
    }
  })
  return [...dists].join(', ')
}

// Extract organizer slug from registration URL path
// e.g. "/Bractwo/zapisy_na_pyra_trail_2026/11223" → "Bractwo"
function extractOrgSlug(url) {
  try {
    const path = new URL(url).pathname
    const parts = path.split('/').filter(Boolean)
    return parts.length >= 1 ? parts[0] : null
  } catch {
    return null
  }
}

// Domains that are NOT organizer websites
const SKIP_DOMAINS = /b4sport|facebook\.com|fb\.com|youtube\.com|instagram\.com|twitter\.com|google\.|tiktok\.com/i

/**
 * Fetch one registration page per organizer slug and extract:
 * - website: from navbar logo link or footer copyright link
 * - regulamin_url: from sidebar nav links to PDFs or regulamin pages
 */
async function fetchOrganizerDetails(orgSlugs) {
  const details = new Map() // orgSlug → { website, regulamin_url }

  for (const slug of orgSlugs) {
    // Fetch the organizer's index page — lighter than a full registration page
    const url = `${BASE_URL}/${slug}/index`
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
        redirect: 'follow',
      })
      const html = await res.text()
      const $ = cheerio.load(html)

      let website = null

      // Clean up malformed URLs like "https://http://example.com"
      const cleanUrl = (u) => u ? u.replace(/^https?:\/\/https?:\/\//, 'https://') : u

      // 1. Navbar logo link: <a href="..."><img class="navbar-logo">
      const logoLink = $('a:has(img.navbar-logo)').first()
      if (logoLink.length) {
        const href = cleanUrl(logoLink.attr('href') || '')
        if (href && href.startsWith('http') && !SKIP_DOMAINS.test(href)) {
          website = href
        }
      }

      // 2. Fallback: footer copyright link — © <a href="..." target="_blank">Org Name</a>
      if (!website) {
        $('div.footer a[target="_blank"]').each((_, a) => {
          if (website) return
          const href = cleanUrl($(a).attr('href') || '')
          if (href && href.startsWith('http') && !SKIP_DOMAINS.test(href)) {
            website = href
          }
        })
      }

      // 3. Regulamin: look for links containing "regulamin" in sidebar/nav
      let regulaminUrl = null
      $('a[href*="users-folder"][href$=".pdf"]').each((_, a) => {
        if (regulaminUrl) return
        const text = $(a).text().toLowerCase()
        if (text.includes('regulamin')) {
          const href = $(a).attr('href') || ''
          regulaminUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`
        }
      })
      // Also check relative regulamin page links
      if (!regulaminUrl) {
        $('a[href]').each((_, a) => {
          if (regulaminUrl) return
          const text = $(a).text().toLowerCase()
          const href = $(a).attr('href') || ''
          if (text.includes('regulamin') && href.startsWith(`/${slug}/`) && !href.includes('lista_uczestnikow')) {
            regulaminUrl = `${BASE_URL}${href}`
          }
        })
      }

      details.set(slug, { website, regulamin_url: regulaminUrl })
      console.log(`[b4sport] Detail ${slug}: website=${website || '-'} regulamin=${regulaminUrl ? 'yes' : '-'}`)
    } catch (err) {
      console.error(`[b4sport] Detail fetch failed for ${slug}:`, err.message?.slice(0, 100))
      details.set(slug, { website: null, regulamin_url: null })
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 500))
  }

  return details
}

function parseEventCards(html, { today }) {
  const $ = cheerio.load(html)
  const events = []

  $('div.event-soon-card').each((_, el) => {
    const card = $(el)
    const inner = card.find('div.col-12').first()

    // City: first short <p> inside flex-column block
    const city = inner.find('div.d-flex.flex-column p').first().text().trim()

    // Name
    const name = inner.find('h6.font-weight-bolder').first().text().trim()
    if (!name || name.length < 4) return
    // Skip garbage names that are just a year or a number (some organizers misuse the title field)
    if (/^\d{4}$/.test(name)) return

    // Date
    const dateText = inner.find('p.event-date').first().text().trim()
    const date = parseCardDate(dateText)
    if (!date) return
    if (date < today) return

    // Link: either single Dołącz or child list
    const content = inner.find('.event-card-content').first()
    const singleLink = content.find('a.link[href]').first()
    const singleHref = singleLink.attr('href') || ''

    const hiddenList = inner.find('.event-card-hidden-list ul.event-card-list-container').first()

    let registrationPath = null
    let distances = ''

    if (hiddenList.length > 0) {
      // Multi-distance card — pick first child link as representative
      const firstChild = hiddenList.find('li a[href]').first()
      registrationPath = firstChild.attr('href') || ''
      distances = extractDistancesFromChildren($, hiddenList)
    } else if (singleHref && singleHref !== '#') {
      registrationPath = singleHref
    } else {
      return // no usable link
    }

    const registrationUrl = registrationPath.startsWith('http')
      ? registrationPath
      : `${BASE_URL}${registrationPath}`

    // source_id: numeric ID from the (first) registration URL
    const numericId = extractNumericId(registrationUrl)
    if (!numericId) return

    // Skip non-running events
    if (SKIP_KEYWORDS.test(name)) return

    events.push({
      name,
      date,
      location: city || '',
      distances,
      registration_url: registrationUrl,
      source: 'b4sport',
      source_id: numericId,
      source_url: registrationUrl,
    })
  })

  return events
}

async function fetchInitialPage() {
  const res = await fetch(LIST_URL, {
    headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
  })
  const html = await res.text()

  // Extract CSRF token and session cookie for subsequent AJAX calls
  const csrfMatch = html.match(/name="csrf-token"\s+content="([^"]+)"/)
  const csrfToken = csrfMatch ? csrfMatch[1] : null

  const setCookie = res.headers.get('set-cookie') || ''
  // We only need the session cookie portion — forward whatever the server gave us
  const cookies = setCookie
    .split(/,\s*(?=[A-Za-z0-9_\-]+=)/)
    .map(c => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')

  return { html, csrfToken, cookies }
}

async function fetchNextPage(nextUrl, csrfToken, cookies) {
  const url = nextUrl.includes('all=1') ? nextUrl : `${nextUrl}&all=1`
  const res = await fetch(`${BASE_URL}${url}`, {
    method: 'POST',
    headers: {
      'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Referer': LIST_URL,
      'Cookie': cookies,
    },
    body: new URLSearchParams({ _csrf: csrfToken }).toString(),
  })

  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function scrape({ knownIds = new Set() } = {}) {
  const today = new Date().toISOString().split('T')[0]
  const all = []
  const seen = new Set()
  const MAX_PAGES = 50 // safety cap — ~500 events max per run

  try {
    const { html, csrfToken, cookies } = await fetchInitialPage()
    if (!csrfToken) {
      console.error('[b4sport] Failed to extract CSRF token — aborting')
      return []
    }

    // Parse initial 10
    const initial = parseEventCards(html, { today })
    for (const ev of initial) {
      if (seen.has(ev.source_id)) continue
      seen.add(ev.source_id)
      all.push(ev)
    }
    console.log(`[b4sport] Initial page: ${initial.length} parsed (total: ${all.length})`)

    // Find starting nextUrl from button
    const $ = cheerio.load(html)
    let nextUrl = $('#getNextForAll').attr('data-url') || null

    let page = 0
    while (nextUrl && page < MAX_PAGES) {
      page++
      const result = await fetchNextPage(nextUrl, csrfToken, cookies)
      if (!result) {
        console.error(`[b4sport] Page ${page}: bad JSON response — stopping`)
        break
      }

      const fragment = result.events || ''
      if (!fragment || fragment.trim() === '') {
        console.log(`[b4sport] Page ${page}: empty — end of list`)
        break
      }

      const parsed = parseEventCards(fragment, { today })
      let added = 0
      for (const ev of parsed) {
        if (seen.has(ev.source_id)) continue
        seen.add(ev.source_id)
        all.push(ev)
        added++
      }
      console.log(`[b4sport] Page ${page}: parsed=${parsed.length} added=${added} (total: ${all.length})`)

      if (result.exceededLimit) {
        console.log('[b4sport] exceededLimit=true — stopping')
        break
      }

      nextUrl = result.nextUrl || null

      // Rate limit: small delay between AJAX calls
      await new Promise(r => setTimeout(r, 400))
    }
  } catch (err) {
    console.error('[b4sport] Scrape failed:', err.message)
    return all
  }

  // Filter against knownIds (already-stored rows)
  const fresh = all.filter(e => !knownIds.has(e.source_id))
  console.log(`[b4sport] Scraped ${all.length} events total (${fresh.length} new, ${all.length - fresh.length} already known)`)

  if (fresh.length === 0) return fresh

  // Step 2: fetch detail pages — one per unique organizer slug
  const orgMap = new Map() // orgSlug → [event indices]
  for (const ev of fresh) {
    const slug = extractOrgSlug(ev.registration_url)
    if (slug) {
      if (!orgMap.has(slug)) orgMap.set(slug, [])
      orgMap.get(slug).push(ev)
    }
  }

  console.log(`[b4sport] Fetching details for ${orgMap.size} unique organizers...`)
  const orgDetails = await fetchOrganizerDetails([...orgMap.keys()])

  // Merge organizer details back into events
  for (const [slug, events] of orgMap) {
    const detail = orgDetails.get(slug)
    if (!detail) continue
    for (const ev of events) {
      if (detail.website) ev.website = detail.website
      if (detail.regulamin_url) ev.regulamin_url = detail.regulamin_url
    }
  }

  const withWebsite = fresh.filter(e => e.website).length
  const withRegulamin = fresh.filter(e => e.regulamin_url).length
  console.log(`[b4sport] Detail enrichment: ${withWebsite}/${fresh.length} with website, ${withRegulamin}/${fresh.length} with regulamin`)

  return fresh
}

export { scrape }
