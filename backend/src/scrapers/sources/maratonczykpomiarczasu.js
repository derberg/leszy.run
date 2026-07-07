import * as cheerio from 'cheerio'
import { verifyPdf } from '../../lib/verifyPdf.js'

const BASE_URL = 'https://www.maratonczykpomiarczasu.pl'
const LIST_URL = `${BASE_URL}/wydarzenia-biegowe`
const UA = 'leszy.run/1.0 (kontakt@leszy.run)'

const SKIP = /\btenis|roller\s+cup|kolarstw|kryterium\s+uliczne|klasyk\s+szosow|gravelow|maraton\s+rowerow|\browerow(?:y|a|e|ej|ego)\b|\bMTB\b|p[lł]ywa[nń]|open\s+water|\btriathlon\b|\bduathlon\b|trimotion|duo\s+cykl|\betap\s+\d/i

// Drupal taxonomy values → standard Polish voivodeship names
const VOIVODESHIP_MAP = {
  'kujawsko pomorskie': 'Kujawsko-Pomorskie',
  'podlaskie': 'Podlaskie',
  'warmińsko-mazurskie': 'Warmińsko-Mazurskie',
}

function normalizeVoivodeship(raw) {
  if (!raw) return null
  const key = raw.trim().toLowerCase()
  return VOIVODESHIP_MAP[key] || raw.trim()
}

// Non-letter boundary — JS \b doesn't recognize Polish letters
const NB = '[^a-ząćęłńóśźż]'

function hasKidsSignal(name) {
  if (!name) return false
  const s = ` ${name.toLowerCase()} `
  if (/(?:biegi|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}świetlik`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

function detectEventTypes(blob) {
  const tags = new Set()
  if (/g[oó]rsk[aiey]|le[sś]n[aey]|\blesie\b|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b/i.test(blob)) tags.add('ocr')
  return [...tags]
}

function cleanDistances(raw) {
  if (!raw) return null
  // Polish decimal comma → dot (e.g. 21,095km → 21.095 km, 42,195 km → 42.195 km)
  // (?!\d) avoids matching thousands separators in larger numbers
  let s = raw.replace(/(\d),(\d{1,3})(?!\d)/g, '$1.$2')
  s = s.replace(/(\d+(?:\.\d+)?)\s*km\b/gi, (_, n) => `${n} km`)
  s = s.replace(/(\d{2,})\s*m\b/g, (_, n) => `${n} m`)
  s = s.trim().replace(/^[,\s]+|[,\s]+$/g, '').replace(/,\s*,+/g, ',').trim()
  return s || null
}

function parseRows($) {
  const results = []
  $('table tr').each((_, tr) => {
    const nameEl = $(tr).find('td.views-field-title a')
    const name = nameEl.text().trim()
    if (!name) return
    if (SKIP.test(name)) return

    const href = nameEl.attr('href') || ''
    const slugRaw = href.replace(/^\/content\//, '')
    if (!slugRaw) return
    const sourceId = decodeURIComponent(slugRaw)

    const dateAttr = $(tr).find('td.views-field-field-event-date span[content]').attr('content') || ''
    const dateMatch = dateAttr.match(/^(\d{4}-\d{2}-\d{2})/)
    if (!dateMatch) return
    const date = dateMatch[1]

    const city = $(tr).find('td.views-field-field-event-city').text().trim() || null
    const voivodeship = normalizeVoivodeship($(tr).find('td.views-field-field-event-province').text().trim())
    const distancesRaw = $(tr).find('td.views-field-field-dystans-biegu').text().trim()
    const distances = cleanDistances(distancesRaw)
    const regUrl = $(tr).find('td.views-field-field-link-do-zapisow a').attr('href') || null
    const websiteRaw = $(tr).find('td.views-field-field-link-do-strony-biegu a').attr('href') || null
    const website = websiteRaw && websiteRaw !== regUrl ? websiteRaw : null

    const blob = `${name} ${distancesRaw}`
    results.push({
      name,
      date,
      location: city,
      voivodeship,
      distances,
      registration_url: regUrl,
      website,
      is_kids: hasKidsSignal(name),
      event_types: detectEventTypes(blob),
      source: 'maratonczykpomiarczasu',
      source_id: sourceId,
      source_url: `${BASE_URL}/content/${slugRaw}`,
    })
  })
  return results
}

async function scrape({ knownIds = new Set() } = {}) {
  const results = []

  let lastPage = 0
  try {
    const res = await fetch(LIST_URL, { headers: { 'User-Agent': UA } })
    const html = await res.text()
    const $ = cheerio.load(html)
    const lastHref = $('li.pager-last a').attr('href') || ''
    const m = lastHref.match(/page=(\d+)/)
    if (m) lastPage = parseInt(m[1], 10)
    results.push(...parseRows($))
  } catch (err) {
    console.error('[maratonczykpomiarczasu] Page 0 failed:', err.message)
    return results
  }

  for (let page = 1; page <= lastPage; page++) {
    try {
      await new Promise(r => setTimeout(r, 1100))
      const res = await fetch(`${LIST_URL}?page=${page}`, { headers: { 'User-Agent': UA } })
      const html = await res.text()
      const $ = cheerio.load(html)
      results.push(...parseRows($))
    } catch (err) {
      console.error(`[maratonczykpomiarczasu] Page ${page} failed:`, err.message)
    }
  }

  const newResults = results.filter(r => !knownIds.has(r.source_id))
  console.log(`[maratonczykpomiarczasu] Listing: ${results.length} events, ${newResults.length} new`)

  // The listing carries no regulamin. Each event's registration page
  // (panel.maratonczykpomiarczasu.pl/<slug>) links the regulamin PDF directly.
  // Fetch it per new event, then VERIFY the PDF is live before writing — a
  // dead/wrong link is dropped, never stored.
  let withRegulamin = 0
  for (const ev of newResults) {
    if (!ev.registration_url) continue
    try {
      await new Promise(r => setTimeout(r, 600))
      const res = await fetch(ev.registration_url, { headers: { 'User-Agent': UA } })
      if (!res.ok) continue
      const $$ = cheerio.load(await res.text())
      let candidate = null
      $$('a[href*=".pdf"]').each((_, a) => {
        if (candidate) return
        const href = $$(a).attr('href') || ''
        const hay = `${href} ${$$(a).text()}`.toLowerCase()
        if (hay.includes('regulamin')) {
          candidate = href.startsWith('http') ? href : new URL(href, ev.registration_url).href
        }
      })
      if (candidate && await verifyPdf(candidate)) {
        ev.regulamin_url = candidate
        withRegulamin++
      }
    } catch (err) {
      console.error(`[maratonczykpomiarczasu] regulamin fetch failed for ${ev.source_id}:`, err.message?.slice(0, 80))
    }
  }
  console.log(`[maratonczykpomiarczasu] regulamin: ${withRegulamin}/${newResults.length} verified`)

  return newResults
}

export { scrape }
