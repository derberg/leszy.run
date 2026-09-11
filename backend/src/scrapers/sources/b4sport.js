import * as cheerio from 'cheerio'
import { verifyPdf } from '../../lib/verifyPdf.js'

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
//
// "brevet" and "audax" name a long-distance cycling ride and nothing else, so
// they are safe to drop on sight. They earn their place here because a brevet
// often carries a name with no cycling word in it at all: KBR Kórnik registered
// its Brevet Niepodległa as "Rajd piastowski z okazji Święta Niepodległości".
// Bare "rajd" stays out of this list, because a rajd is as often a walk.
//
// The cycling stems run to the end of the word. Polish declines them, and
// `rowerow[aey]?` read "Festiwal Turystyki Rowerowej" as a running event
// because it stopped one letter short of "rowerowej". "rajd rowerowy" is gone
// as a phrase: `rowerow[a-z]*` already covers it.
const SKIP_KEYWORDS = /\b(mtb|rowerow[a-z]*|kolarsk[a-z]*|triathlon|duathlon|bike race|bike|aquathlon|gravel|gravelow[a-z]*|enduro|sup race|wrotkars[a-z]*|brevet[a-z]*|audax|jumping zoo|skill lab|turniej|3v3)\b/i

// The words of a registration slug, for SKIP_KEYWORDS to read.
//
// b4sport URLs are /<organizer>/<event slug>/<id>, and the event slug often
// names the race the organizer actually runs while the listing title does not.
// Only that one segment is read. The organizer segment is excluded on purpose:
// a club called "bike_team" would otherwise lose every running event it hosts.
// Underscores are word characters to a regex, so `brevet_niepodlegla` hides
// `\bbrevet\b` until the separators become spaces.
function registrationSlugWords(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    return parts.length >= 2 ? parts[1].replace(/[^a-zA-Z0-9]+/g, ' ') : ''
  } catch {
    return ''
  }
}

// Whether this listing row is a sport we do not carry.
function isNonRunningEvent(name, registrationUrl) {
  return SKIP_KEYWORDS.test(name || '') ||
    SKIP_KEYWORDS.test(registrationSlugWords(registrationUrl))
}

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

// Strip Polish diacritics + non-letters so a city name matches the way it
// appears in a regulamin filename (e.g. "Gdynia" → "gdynia",
// "regulamin_x_gdynia_x_formoza…pdf" → "…gdynia…").
function citySlug(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, ch => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[ch] || ch))
    .replace(/[^a-z0-9]/g, '')
}

// Lowercase + de-diacritic, keeping word boundaries. citySlug() also strips
// spaces, which is right for filename matching but destroys phrase markers.
function plainText(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, ch => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[ch] || ch))
    .replace(/\s+/g, ' ')
}

// Words that appear in nearly every Polish race name. They cannot tell two
// races on the same organizer's site apart.
const NAME_STOPWORDS = new Set([
  'bieg', 'biegi', 'biegu', 'biegow', 'biegowe', 'biegowy', 'biegowa', 'biegach',
  'marsz', 'marszu', 'edycja', 'edycji', 'memorial', 'memorialu', 'imprezy',
  'zawody', 'zawodow', 'otwarte', 'otwarty', 'oraz', 'roku', 'zycia', 'lata',
  'doroslych', 'dzieci', 'nordic', 'walking', 'ogolnopolski', 'ogolnopolskie',
])

// The tokens of an event name that separate it from another race. "Mile
// Biegowe" and "Mistrzostwa Koszalina na dystansie 5 000m" differ on "mile".
function nameTokens(name) {
  return [...new Set(
    plainText(name)
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 4 && !NAME_STOPWORDS.has(t) && !/^\d+$/.test(t))
  )]
}

// Collect candidate regulamin links from a loaded page: PDFs anywhere, plus
// HTML pages under this organizer's own b4sport path. Only links whose href or
// text mentions "regulamin" qualify (skips oświadczenie/zgoda documents).
//
// Not every organizer publishes a PDF. TKKF Koszalin serves its regulamin as
// an ordinary page at /Biegi_Koszalin_2016/mile, where a PDF-only collector
// finds nothing. Distances, price and registration deadline all live in the
// regulamin, so that page is the only source for any of them. HTML candidates
// are scoped to `/<slug>/`, which keeps another organizer's regulamin out.
function collectRegulaminLinks($, slug) {
  const out = []
  const push = (href, text, kind) => {
    const hay = `${href} ${text}`.toLowerCase()
    if (!hay.includes('regulamin')) return
    const url = href.startsWith('http')
      ? href
      : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`
    out.push({ url, hay: citySlug(hay), text, kind })
  }

  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') || '').trim()
    if (!href || href.startsWith('#') || /^(mailto|javascript|tel):/i.test(href)) return
    const text = $(a).text()

    if (href.toLowerCase().includes('.pdf')) {
      push(href, text, 'pdf')
      return
    }
    if (!slug) return
    // Same-organizer HTML page only.
    const path = href.startsWith('http')
      ? (href.startsWith(BASE_URL) ? href.slice(BASE_URL.length) : null)
      : (href.startsWith('/') ? href : `/${href}`)
    if (!path || !path.startsWith(`/${slug}/`)) return
    push(href, text, 'html')
  })
  return out
}

// Section headings every Polish regulamin carries. A menu page or a soft-404
// that only links the word "Regulamin" carries none of them.
const REGULAMIN_MARKERS = [
  'cel imprezy', 'organizator', 'uczestnictw', 'zgloszen', 'zapisy',
  'oplat', 'trasa', 'postanowienia', 'nagrody', 'klasyfikacj', 'termin',
]

/**
 * Verify an HTML regulamin page. CLAUDE.md's URL rule states that a 200 is not
 * proof, because the destination must carry event-specific content. So a page
 * has to pass four checks. It answers with live HTML. Its body holds at least
 * 1500 characters. It shows at least three regulamin section headings. It
 * names at least one distinctive token of this event's name. A page that
 * misses any of them is dropped rather than written.
 *
 * Checked against the live source on 2026-09-11. /Biegi_Koszalin_2016/mile
 * passes. The event page /Biegi_Koszalin_2016/…/13036 fails, although the same
 * menu links the word "Regulamin" from it. The rejected alternative was to
 * trust any same-organizer page that mentions the word. That would have
 * written the event page as the regulamin for every race on the site.
 *
 * @returns {Promise<boolean>}
 */
async function verifyRegulaminPage(url, eventName, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const tokens = nameTokens(eventName)
  if (tokens.length === 0) return false
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    if (!res.ok) return false
    if (!(res.headers.get('content-type') || '').toLowerCase().includes('text/html')) return false

    const $ = cheerio.load(await res.text())
    $('script, style, nav, header, footer').remove()
    const text = plainText($('body').text())
    if (text.length < 1500) return false

    const markers = REGULAMIN_MARKERS.filter(m => text.includes(m)).length
    if (markers < 3) return false
    return tokens.some(t => text.includes(t))
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// Pick the regulamin for one event from an organizer's candidate list, then
// verify it before returning. Two things make the choice ambiguous. A
// multi-city series such as Formoza exposes one regulamin per city. A single
// organizer often runs several races off one site: Koszalin has a 5000 m
// championship and a mile series. So the event's own name settles the choice
// first, and a city match settles it second. Neither one conclusive means no
// choice at all. Writing the wrong race's regulamin is worse than writing
// none. Returns a verified URL or null.
async function pickRegulamin(candidates, city, eventName, deps = {}) {
  const { verifyPdfFn = verifyPdf, verifyPageFn = verifyRegulaminPage } = deps
  if (!candidates || candidates.length === 0) return null

  let chosen = null

  // Tier 1: distinctive tokens of this event's name. This needs an outright
  // winner. A tie means two races share the wording and neither is provable.
  const scored = candidates
    .map(c => ({ c, score: nameTokens(eventName).filter(t => c.hay.includes(t)).length }))
    .sort((a, b) => b.score - a.score)
  if (scored[0].score > 0 && (scored.length === 1 || scored[0].score > scored[1].score)) {
    chosen = scored[0].c
  }

  // Tier 2: city, for a multi-city series. Unique for the same reason.
  if (!chosen) {
    const cs = citySlug(city)
    const hits = cs ? candidates.filter(c => c.hay.includes(cs)) : []
    if (hits.length === 1) chosen = hits[0]
  }

  // Tier 3: a lone PDF on an organizer that runs one race. HTML never reaches
  // this tier. A menu link repeats on every page of the site, so being the
  // only candidate proves nothing about which race it covers.
  if (!chosen && candidates.length === 1 && candidates[0].kind === 'pdf') chosen = candidates[0]

  if (!chosen) return null
  const ok = chosen.kind === 'html'
    ? await verifyPageFn(chosen.url, eventName)
    : await verifyPdfFn(chosen.url)
  return ok ? chosen.url : null
}

/**
 * Fetch organizer pages per slug and extract:
 * - website: from navbar logo link or footer copyright link (index page)
 * - regulaminCandidates: regulamin links, both PDFs and same-organizer HTML
 *   pages, from the index page AND the dedicated /<slug>/regulamin route
 *   (which lists per-city PDFs for series). Per-event selection and
 *   verification happen later in pickRegulamin().
 */
async function fetchOrganizerDetails(orgSlugs) {
  const details = new Map() // orgSlug → { website, regulaminCandidates }
  const cleanUrl = (u) => u ? u.replace(/^https?:\/\/https?:\/\//, 'https://') : u

  for (const slug of orgSlugs) {
    let website = null
    const candidates = []

    // 1. Index page — website + any regulamin links present there
    try {
      const res = await fetch(`${BASE_URL}/${slug}/index`, {
        headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
        redirect: 'follow',
      })
      const $ = cheerio.load(await res.text())

      const logoLink = $('a:has(img.navbar-logo)').first()
      if (logoLink.length) {
        const href = cleanUrl(logoLink.attr('href') || '')
        if (href && href.startsWith('http') && !SKIP_DOMAINS.test(href)) website = href
      }
      if (!website) {
        $('div.footer a[target="_blank"]').each((_, a) => {
          if (website) return
          const href = cleanUrl($(a).attr('href') || '')
          if (href && href.startsWith('http') && !SKIP_DOMAINS.test(href)) website = href
        })
      }
      candidates.push(...collectRegulaminLinks($, slug))
    } catch (err) {
      console.error(`[b4sport] Index fetch failed for ${slug}:`, err.message?.slice(0, 100))
    }

    // 2. Dedicated regulamin route — lists per-city regulamin PDFs
    try {
      await new Promise(r => setTimeout(r, 300))
      const res = await fetch(`${BASE_URL}/${slug}/regulamin`, {
        headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
        redirect: 'follow',
      })
      if (res.ok) {
        const $ = cheerio.load(await res.text())
        candidates.push(...collectRegulaminLinks($, slug))
      }
    } catch (err) {
      console.error(`[b4sport] Regulamin route failed for ${slug}:`, err.message?.slice(0, 100))
    }

    // Dedup candidates by url, ignoring the ?lang= switcher. b4sport renders
    // the same regulamin at ?lang=pl and ?lang=en. Left in, the pair ties on
    // every selection tier, and an organizer whose only regulamin is that
    // route resolves to nothing.
    const seen = new Set()
    const regulaminCandidates = candidates.filter(c => {
      const key = c.url.replace(/[?&]lang=[a-z]{2}\b/i, '')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    details.set(slug, { website, regulaminCandidates })
    console.log(`[b4sport] Detail ${slug}: website=${website || '-'} regulaminCandidates=${regulaminCandidates.length}`)

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
    if (isNonRunningEvent(name, registrationUrl)) return

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

  // Merge organizer details back into events. Regulamin is chosen per-event
  // (matched on the event's own name, then city) and verified before writing.
  for (const [slug, events] of orgMap) {
    const detail = orgDetails.get(slug)
    if (!detail) continue
    for (const ev of events) {
      if (detail.website) ev.website = detail.website
      const regulamin = await pickRegulamin(detail.regulaminCandidates, ev.location, ev.name)
      if (regulamin) ev.regulamin_url = regulamin
    }
  }

  const withWebsite = fresh.filter(e => e.website).length
  const withRegulamin = fresh.filter(e => e.regulamin_url).length
  console.log(`[b4sport] Detail enrichment: ${withWebsite}/${fresh.length} with website, ${withRegulamin}/${fresh.length} with regulamin`)

  return fresh
}

export { scrape, fetchOrganizerDetails, pickRegulamin, collectRegulaminLinks, verifyRegulaminPage, nameTokens, registrationSlugWords, isNonRunningEvent }
