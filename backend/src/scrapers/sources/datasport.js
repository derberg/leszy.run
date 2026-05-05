import * as cheerio from 'cheerio'

const BASE_URL = 'https://liveds.datasport.pl'
const LIST_URL = `${BASE_URL}/lista.html`

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

    headings.each((_, el) => {
      const text = $(el).text().trim()
      // Extract km from heading like "Bieg 10km", "Bieg 5 km", "Półmaraton"
      const kmMatch = text.match(/(\d+[.,]?\d*)\s*km/i)
      if (kmMatch) {
        const km = parseFloat(kmMatch[1].replace(',', '.'))
        const label = `${km} km`
        if (km > 0 && km < 500 && !distances.includes(label)) distances.push(label)
      }
      // Named distances
      if (/półmaraton|polmaraton/i.test(text) && !distances.some(d => d.includes('21'))) {
        distances.push('21.1 km')
      }
      if (/\bmaraton\b/i.test(text) && !/pół|pol/i.test(text) && !distances.some(d => d.includes('42'))) {
        distances.push('42.2 km')
      }
      // Time-based durations (e.g., "Bieg 4h", "Bieg 6H")
      const hourMatch = text.match(/\b(\d{1,2})\s*[hH]\b/)
      if (hourMatch) {
        const hours = parseInt(hourMatch[1])
        const label = `${hours}h`
        if (hours > 0 && hours <= 48 && !distances.includes(label)) distances.push(label)
      }
    })

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

async function scrape({ knownIds = new Set() } = {}) {
  const results = []

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

    const newEntries = entries.filter(e => !knownIds.has(e.sourceId))
    console.log(`[datasport] Found ${entries.length} events, ${newEntries.length} new (skipping ${entries.length - newEntries.length} known)`)

    // Fetch detail pages only for new events
    for (let i = 0; i < newEntries.length; i++) {
      const entry = newEntries[i]
      let distances = ''

      let regulaminUrl = null
      const detail = await fetchDetailPage(entry.sourceId)
      if (detail) {
        distances = detail.distances
        regulaminUrl = detail.regulaminUrl
      }

      // The exact URL datasport's own "Zapisz się na zawody" button uses on the
      // public event page. Goes through liveds.datasport.pl's anti-bot queue,
      // then to the per-race signup form (which itself enforces login). Verified
      // by scraping the public event page on 6 different competition IDs — same
      // pattern every time. Tried two seemingly-cleaner alternatives first:
      //   online.datasport.pl/zapisy/portal/baza/wizardnew/?zawody=<id>  → 302 to login.php (no event context)
      //   online.datasport.pl/zapisy/portal/form/?zawody=<id>&co=form    → 302 to zaloguj.php (no event context)
      // Both lose the race ID after redirect. The /queue/?redirect_url=… form
      // URL preserves it through the auth round-trip, so post-login the user
      // lands on the right race's signup form.
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

export { scrape }
