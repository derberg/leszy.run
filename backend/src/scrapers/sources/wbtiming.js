import * as cheerio from 'cheerio'

const BASE_URL = 'https://wbtiming.pl'

// Badge or name patterns that indicate non-running events — skip these
const SKIP_RUNNING = /rowerow[aey]?|maraton mtb|\bmtb\b|kolarsk[aiey]?/i

function parseDdMmYyyy(str) {
  const m = str && str.match(/^(\d{2})-(\d{2})-(\d{4})$/)
  if (!m) return null
  return `${m[3]}-${m[2]}-${m[1]}`
}

function detectEventTypes(badge, name) {
  const blob = ((badge || '') + ' ' + (name || '')).toLowerCase()
  const tags = []
  if (/nordic\s*walking|\bnw\b/i.test(blob)) tags.push('nordic walking')
  if (/\bultra\b/i.test(blob)) tags.push('ultra')
  if (/g[oó]rsk[aiey]|le[sś]n[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.push('trail')
  if (/\bocr\b/i.test(blob)) tags.push('ocr')
  if (/charytatywn/i.test(blob)) tags.push('charytatywny')
  return tags
}

const NB = '[^a-ząćęłńóśźż]'
function detectIsKids(badge, name) {
  const blob = ((badge || '') + ' ' + (name || '')).toLowerCase()
  if (/dzieci[eę]?c/i.test(blob)) return true
  if (new RegExp(`${NB}świetlik`).test(blob)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(blob)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(blob)) return true
  return false
}

async function fetchDetailPage(slug) {
  try {
    const url = `${BASE_URL}/${slug}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    // Location: anchor text of the Google Maps link after "Lokalizacja:" in <P class=lead>
    let location = null
    $('p, P').each((_, el) => {
      if (location) return
      const inner = $(el).html() || ''
      if (!/lokalizacja/i.test(inner)) return
      $(el).find('a').each((_, a) => {
        const href = $(a).attr('href') || ''
        if (href.includes('maps') || href.includes('goo.gl')) {
          location = $(a).text().trim() || null
        }
      })
    })

    // Distances: collect "N km" values from the description (ignore navigation/footer)
    const distRegex = /(\d[\d,\.]*)\s*km/gi
    const allDists = []
    $('p, P, strong, STRONG').each((_, el) => {
      const text = $(el).text()
      let m
      distRegex.lastIndex = 0
      while ((m = distRegex.exec(text)) !== null) {
        const raw = m[1]
        const val = parseFloat(raw.replace(',', '.'))
        if (val >= 1 && val <= 200) {
          allDists.push({ val, display: Number.isInteger(val) ? `${val} km` : `${raw.replace('.', ',')} km` })
        }
      }
    })
    // Sort ascending, then deduplicate by integer bucket — prefer decimal-precise value
    allDists.sort((a, b) => a.val - b.val)
    const buckets = new Map()
    for (const d of allDists) {
      const key = Math.round(d.val)
      if (!buckets.has(key)) {
        buckets.set(key, d)
      } else if (!Number.isInteger(d.val) && Number.isInteger(buckets.get(key).val)) {
        buckets.set(key, d)
      }
    }
    const distArr = [...buckets.values()].map(d => d.display)

    // Regulamin: btn with href /Files/Regulations/
    let regulaminUrl = null
    $('a[href*="/Files/Regulations/"]').each((_, a) => {
      if (regulaminUrl) return
      const href = $(a).attr('href')
      regulaminUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`
    })

    // Registration URL: first dropdown-item Zapisy link (prefer non-kids)
    let registrationUrl = null
    $('a.dropdown-item[href*="/Rejestracja"]').each((_, a) => {
      if (registrationUrl) return
      const href = $(a).attr('href')
      const text = $(a).text()
      // Skip kids-only links unless no other option
      if (/dzieci/i.test(text) && registrationUrl) return
      registrationUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`
    })

    // Website: first external link in description paragraphs (not maps, not wbtiming, not socials)
    let website = null
    $('p a[href^="http"], P a[href^="http"]').each((_, a) => {
      if (website) return
      const href = $(a).attr('href') || ''
      if (href.includes('wbtiming.pl')) return
      if (href.includes('maps.app.goo.gl') || href.includes('goo.gl/maps')) return
      if (href.includes('facebook.com') || href.includes('instagram.com')) return
      website = href
    })

    return {
      location,
      distances: distArr.join(', ') || null,
      regulaminUrl,
      registrationUrl,
      website,
    }
  } catch (err) {
    console.error(`[wbtiming] Detail fetch failed for ${slug}:`, err.message)
    return null
  }
}

async function scrape({ knownIds = new Set() } = {}) {
  const eventEntries = []

  try {
    const res = await fetch(`${BASE_URL}/Kalendarz`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })
    const html = await res.text()
    const $ = cheerio.load(html)

    // Find all <b> elements whose text matches DD-MM-YYYY (the date pattern).
    // Their parent <div> is the event container for that entry.
    $('b').each((_, bEl) => {
      const dateText = $(bEl).text().trim()
      if (!/^\d{2}-\d{2}-\d{4}$/.test(dateText)) return
      const date = parseDdMmYyyy(dateText)
      if (!date) return

      const container = $(bEl).parent()

      // Badge type
      const badge = container.find('span.badge').first().text().trim()

      // Skip cycling/MTB events by badge first (fast path)
      if (SKIP_RUNNING.test(badge)) return

      // Must have an internal event page link (rel="tooltip")
      const nameLink = container.find('a[rel="tooltip"]').first()
      if (!nameLink.length) return

      const name = nameLink.text().trim()

      // Also skip if name itself reveals cycling (e.g. "MTB XC Cytadela")
      if (SKIP_RUNNING.test(name)) return
      const href = nameLink.attr('href') || ''
      if (!href || !href.startsWith('/') || href === '/') return

      const slug = href.slice(1)
      if (!slug) return

      // Registration link from dropdown (first Zapisy link in this container)
      const regLink = container.find('a.dropdown-item[href*="/Rejestracja"]').first()
      const regHref = regLink.length ? regLink.attr('href') : null
      const listingRegUrl = regHref
        ? (regHref.startsWith('http') ? regHref : `${BASE_URL}${regHref}`)
        : null

      eventEntries.push({ name, slug, date, badge, listingRegUrl })
    })
  } catch (err) {
    console.error(`[wbtiming] Listing scrape failed:`, err.message)
    return []
  }

  // Deduplicate by slug (same event can appear under both "Ostatnie" and "Najbliższe")
  const seen = new Set()
  const unique = []
  for (const e of eventEntries) {
    if (!seen.has(e.slug)) {
      seen.add(e.slug)
      unique.push(e)
    }
  }

  const newEntries = unique.filter(e => !knownIds.has(e.slug))
  console.log(`[wbtiming] Found ${unique.length} events, ${newEntries.length} new (skipping ${unique.length - newEntries.length} known)`)

  const results = []

  for (const entry of newEntries) {
    const detail = await fetchDetailPage(entry.slug)

    results.push({
      name: entry.name,
      date: entry.date,
      location: detail?.location || null,
      distances: detail?.distances || null,
      registration_url: detail?.registrationUrl || entry.listingRegUrl || `${BASE_URL}/${entry.slug}`,
      regulamin_url: detail?.regulaminUrl || null,
      website: detail?.website || null,
      is_kids: detectIsKids(entry.badge, entry.name),
      event_types: detectEventTypes(entry.badge, entry.name),
      source: 'wbtiming',
      source_id: entry.slug,
      source_url: `${BASE_URL}/${entry.slug}`,
    })

    console.log(`[wbtiming] Detail: ${results.length}/${newEntries.length} — ${entry.name}`)

    await new Promise(r => setTimeout(r, 1100))
  }

  console.log(`[wbtiming] Scraped ${results.length} events`)
  return results
}

export { scrape }
