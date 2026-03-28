import { chromium } from 'playwright'
import * as cheerio from 'cheerio'

const BASE_URL = 'https://maratonypolskie.pl'
const SEARCH_URL = `${BASE_URL}/mp_index.php?dzial=3&action=1&grp=13&trgr=1&bieganie&wyswietl=Tekstowo&region=Polska`

const MONTHS_PL = [
  'styczen', 'luty', 'marzec', 'kwiecien', 'maj', 'czerwiec',
  'lipiec', 'sierpien', 'wrzesien', 'pazdziernik', 'listopad', 'grudzien'
]

const MAX_RETRIES = 3

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

    if (!name || name.length < 3) continue

    const key = `${name}-${date}`
    if (seen.has(key)) continue
    seen.add(key)

    const href = nameLink.attr('href') || ''
    const codeMatch = href.match(/code=(\d+)/)
    const sourceId = codeMatch ? codeMatch[1] : key

    events.push({
      name,
      date,
      location: location.length > 1 && location.length < 40 ? location : '',
      distances: distance,
      registration_url: null,
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
  const startMonth = now.getMonth()
  const startYear = now.getFullYear()

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let browser
    try {
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage()
      page.setDefaultTimeout(15000)

      await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1000)

      for (let i = 0; i < 12; i++) {
        let monthIdx = startMonth + i
        let year = startYear
        if (monthIdx >= 12) {
          monthIdx -= 12
          year++
        }

        const monthValue = MONTHS_PL[monthIdx]

        try {
          const currentYear = await page.$eval('select[name="czasr1"]', el => el.value)
          if (currentYear !== String(year)) {
            await page.selectOption('select[name="czasr1"]', String(year))
            await page.waitForLoadState('domcontentloaded')
            await page.waitForTimeout(1000)
          }

          await page.selectOption('select[name="czasm1"]', monthValue)
          await page.waitForLoadState('domcontentloaded')
          await page.waitForTimeout(1500)

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

      // Success — break retry loop
      break

    } catch (err) {
      console.error(`[maratonypolskie] Attempt ${attempt}/${MAX_RETRIES} failed:`, err.message?.slice(0, 200))
      if (attempt === MAX_RETRIES) {
        console.error(`[maratonypolskie] ❌ ALL ${MAX_RETRIES} ATTEMPTS FAILED — check Playwright installation and maratonypolskie.pl availability`)
      }
    } finally {
      if (browser) await browser.close()
    }
  }

  console.log(`[maratonypolskie] Scraped ${allEvents.length} events total`)
  return allEvents
}

export { scrape }
