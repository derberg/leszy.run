import { chromium } from 'playwright'
import * as cheerio from 'cheerio'

const BASE_URL = 'https://maratonypolskie.pl'
const SEARCH_URL = `${BASE_URL}/mp_index.php?dzial=3&action=1&grp=13&trgr=1&bieganie&wyswietl=Tekstowo&region=Polska`

const MONTHS_PL = [
  'styczen', 'luty', 'marzec', 'kwiecien', 'maj', 'czerwiec',
  'lipiec', 'sierpien', 'wrzesien', 'pazdziernik', 'listopad', 'grudzien'
]

function parseSearchResults(html, today) {
  const $ = cheerio.load(html)
  const events = []
  const seen = new Set()

  const allCells = $('td')
  let inSearchResults = false

  for (let i = 0; i < allCells.length; i++) {
    const cellText = $(allCells[i]).text().trim()

    if (cellText.includes('wyszukane')) {
      inSearchResults = true
      while (i < allCells.length) {
        if ($(allCells[i]).text().trim() === 'NAZWA') { i++; break }
        i++
      }
      continue
    }

    if (!inSearchResults) continue

    const dateMatch = cellText.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/)
    if (!dateMatch) continue

    const date = `${dateMatch[3]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`
    if (date < today) continue

    i++
    if (i >= allCells.length) break
    const cityText = $(allCells[i]).text().trim()
    const cityDistMatch = cityText.match(/^(.+?)(\d+[\.,]?\d*\s*km\.?)$/i)
    const location = cityDistMatch ? cityDistMatch[1].trim() : cityText
    const distance = cityDistMatch ? cityDistMatch[2].trim() : ''

    i++
    if (i >= allCells.length) break
    const nameCell = $(allCells[i])
    const nameLink = nameCell.find('a').first()
    const name = nameLink.text().trim() || nameCell.text().trim()
    const href = nameLink.attr('href') || ''

    if (!name || name.length < 3) continue

    const key = `${name}-${date}`
    if (seen.has(key)) continue
    seen.add(key)

    const codeMatch = href.match(/code=(\d+)/)
    const sourceId = codeMatch ? codeMatch[1] : key

    events.push({
      name,
      date,
      location: location.length > 1 && location.length < 40 ? location : '',
      distances: distance,
      registration_url: null,
      _detailUrl: href ? (href.startsWith('http') ? href : `${BASE_URL}/${href}`) : null,
      source: 'maratonypolskie',
      source_url: SEARCH_URL,
      source_id: sourceId,
    })
  }

  return events
}

async function scrape() {
  const allEvents = []
  const allSeen = new Set()
  const now = new Date()
  const today = now.toISOString().split('T')[0]
  const startMonth = now.getMonth() // 0-indexed
  const startYear = now.getFullYear()

  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    page.setDefaultTimeout(15000)

    // Load the initial page
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)

    // Scrape 12 months ahead
    for (let i = 0; i < 12; i++) {
      let monthIdx = startMonth + i
      let year = startYear
      if (monthIdx >= 12) {
        monthIdx -= 12
        year++
      }

      const monthValue = MONTHS_PL[monthIdx]

      try {
        // Select year if different from current
        const currentYear = await page.$eval('select[name="czasr1"]', el => el.value)
        if (currentYear !== String(year)) {
          await page.selectOption('select[name="czasr1"]', String(year))
          await page.waitForLoadState('domcontentloaded')
          await page.waitForTimeout(1000)
        }

        // Select month — this triggers form submit via onchange
        await page.selectOption('select[name="czasm1"]', monthValue)
        await page.waitForLoadState('domcontentloaded')
        await page.waitForTimeout(1500)

        // Get the rendered HTML
        const html = await page.content()
        const events = parseSearchResults(html, today)

        let added = 0
        for (const event of events) {
          const key = `${event.name}-${event.date}`
          if (!allSeen.has(key)) {
            allSeen.add(key)
            allEvents.push(event)
            added++
          }
        }

        console.log(`[maratonypolskie] ${monthValue} ${year}: ${added} new events (total: ${allEvents.length})`)
      } catch (err) {
        console.error(`[maratonypolskie] Failed for ${monthValue} ${year}:`, err.message?.slice(0, 100))
      }
    }

    // Phase 2: fetch detail pages for each event (reuse browser session)
    console.log(`[maratonypolskie] Fetching detail pages for ${allEvents.length} events...`)
    for (let idx = 0; idx < allEvents.length; idx++) {
      const event = allEvents[idx]
      if (!event._detailUrl) continue

      try {
        await page.goto(event._detailUrl, { waitUntil: 'domcontentloaded', timeout: 10000 })
        await page.waitForTimeout(500)

        const detailHtml = await page.content()
        const $d = cheerio.load(detailHtml)
        const pageText = $d('body').text().replace(/\s+/g, ' ').trim()

        // Store raw description (up to 5000 chars)
        event.description = pageText.slice(0, 5000)

        // Extract distances from detail page
        const distMatches = [...pageText.matchAll(/(\d+[\.,]?\d*)\s*km/gi)]
        const distances = []
        for (const m of distMatches) {
          const km = parseFloat(m[1].replace(',', '.'))
          const label = `${km} km`
          if (km > 0 && km < 500 && !distances.includes(label)) distances.push(label)
        }
        if (pageText.toLowerCase().includes('półmaraton') && !distances.some(d => d.includes('21'))) {
          distances.push('21.1 km')
        }
        if (/\bmaraton\b/i.test(pageText) && !pageText.toLowerCase().includes('pół') && !distances.some(d => d.includes('42'))) {
          distances.push('42.2 km')
        }
        if (distances.length > 0) {
          event.distances = distances.join(', ')
        }

        if ((idx + 1) % 50 === 0) {
          console.log(`[maratonypolskie] Detail pages: ${idx + 1}/${allEvents.length}`)
        }
      } catch (err) {
        // Skip failed detail pages silently
      }
    }
    console.log(`[maratonypolskie] Detail pages done`)

  } catch (err) {
    console.error('[maratonypolskie] Browser launch failed:', err.message?.slice(0, 200))
    console.log('[maratonypolskie] Falling back to simple fetch (current month only)...')

    // Fallback: simple fetch without Playwright
    try {
      const res = await fetch(SEARCH_URL, { headers: { 'User-Agent': 'leszy.run/1.0' } })
      const buffer = await res.arrayBuffer()
      const html = new TextDecoder('iso-8859-2').decode(buffer)
      const events = parseSearchResults(html, today)
      events.forEach(e => { if (!allSeen.has(`${e.name}-${e.date}`)) { allSeen.add(`${e.name}-${e.date}`); allEvents.push(e) } })
    } catch (fallbackErr) {
      console.error('[maratonypolskie] Fallback also failed:', fallbackErr.message)
    }
  } finally {
    if (browser) await browser.close()
  }

  console.log(`[maratonypolskie] Scraped ${allEvents.length} events total`)
  return allEvents
}

export { scrape }
