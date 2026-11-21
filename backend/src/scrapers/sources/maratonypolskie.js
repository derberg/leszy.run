import { chromium } from 'playwright'
import * as cheerio from 'cheerio'

const BASE_URL = 'https://maratonypolskie.pl'
const SEARCH_URL = `${BASE_URL}/mp_index.php?dzial=3&action=1&grp=13&trgr=1&bieganie&wyswietl=Tekstowo&region=Polska`

const MONTHS_PL = [
  'styczen', 'luty', 'marzec', 'kwiecien', 'maj', 'czerwiec',
  'lipiec', 'sierpien', 'wrzesien', 'pazdziernik', 'listopad', 'grudzien'
]

const MAX_RETRIES = 3

// Event names to skip (substring match, case-insensitive, whitespace-insensitive —
// the site renders both "ITMBWieczorem" and "Itmb Wieczorem").
// "WtorkiBiegowe" = "Wtorki Biegowe - Maraton na Raty", a recurring weekly training
// run series (one entry per Tuesday) — repeatedly rejected spam, also blocked at
// merge level.
const IGNORED_NAMES = ['ITMBWieczorem', 'WtorkiBiegowe']

// The search list has no discipline, sign-up link or fees; the event's detail page
// (action=5) carries all three. The site serves it in iso-8859-2.
const DETAIL_URL = (code) => `https://www.maratonypolskie.pl/mp_index.php?dzial=3&action=5&code=${code}`

// Discipline label next to pikto/dyscypN.png → the event_type other scrapers use.
// Unknown labels stay unset rather than guessed.
const DISCIPLINE_MAP = {
  biegi: 'bieg',
}

function parseDetailPage(html) {
  const $ = cheerio.load(html)

  const label = $('img[src*="pikto/dyscyp"]').first().closest('tr').text().trim().toLowerCase()
  const event_type = DISCIPLINE_MAP[label] || null

  let registration_url = null
  const signup = $('a[target="zglosz"]').first().attr('href')
  if (signup) {
    try { registration_url = new URL(signup, 'https://www.maratonypolskie.pl/').href } catch { /* malformed href */ }
  }

  // Fee tiers: orange "179 pln" cells inside the table headed "OPŁATY STARTOWE".
  const prices = []
  // Closest table only, so orange text elsewhere on the page is not read as a fee.
  $('b').filter((_, b) => /OPŁATY STARTOWE/i.test($(b).text()))
    .closest('table')
    .find('font[color="orange" i]')
    .each((_, el) => {
      const m = $(el).text().match(/(\d+(?:[.,]\d+)?)\s*pln/i)
      if (m) prices.push(Number(m[1].replace(',', '.')))
    })

  return {
    event_type,
    registration_url,
    price_from: prices.length ? Math.min(...prices) : null,
    price_to: prices.length ? Math.max(...prices) : null,
  }
}

async function fetchDetail(code) {
  const res = await fetch(DETAIL_URL(code), { headers: { 'User-Agent': 'leszy.run/1.0 (lukasz@leszy.run)' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parseDetailPage(new TextDecoder('iso-8859-2').decode(await res.arrayBuffer()))
}

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
    // City cell structure: "Spała<p align="right">21.097 km, 5 km</p>" — distances live in
    // a nested <p>, so extract it separately instead of regexing the concatenated text
    // (the old regex only peeled off the last distance, leaving "Spała21.097 km," as location).
    const cityCell = $(allCells[i])
    const distP = cityCell.find('p')
    let location, distance
    if (distP.length) {
      distance = distP.text().trim()
      distP.remove()
      location = cityCell.text().trim()
    } else {
      const cityText = cityCell.text().trim()
      const cityDistMatch = cityText.match(/^(.+?)(\d+[\.,]?\d*\s*km\.?)$/i)
      location = cityDistMatch ? cityDistMatch[1].trim() : cityText
      distance = cityDistMatch ? cityDistMatch[2].trim() : ''
    }

    i++
    if (i >= allCells.length) break
    // Name cell can contain a <br> subtitle ("V RUNda Żubra<br>Biegi i Nordic Walking") —
    // join with a space so words don't glue together ("ŻubraBiegi").
    const nameCell = $(allCells[i])
    nameCell.find('br').replaceWith(' ')
    const nameLink = nameCell.find('a').first()
    const name = (nameLink.text().trim() || nameCell.text().trim()).replace(/\s+/g, ' ')

    if (!name || name.length < 3) continue

    if (IGNORED_NAMES.some(ignored => name.toLowerCase().replace(/\s+/g, '').includes(ignored.toLowerCase()))) continue

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

async function scrape({ knownIds = new Set() } = {}) {
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
            if (!allSeen.has(key) && !knownIds.has(event.source_id)) {
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

  // Only new events reach here (known source_ids are skipped above).
  for (const event of allEvents) {
    if (!/^\d+$/.test(event.source_id)) continue
    try {
      const detail = await fetchDetail(event.source_id)
      if (detail.event_type) event.event_type = detail.event_type
      if (detail.registration_url) event.registration_url = detail.registration_url
      if (detail.price_from != null) {
        event.price_from = detail.price_from
        event.price_to = detail.price_to
      }
    } catch (err) {
      console.error(`[maratonypolskie] Detail ${event.source_id} failed:`, err.message?.slice(0, 100))
    }
    await new Promise(r => setTimeout(r, 300))
  }

  console.log(`[maratonypolskie] Scraped ${allEvents.length} events total`)
  return allEvents
}

export { scrape, parseDetailPage }
