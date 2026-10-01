import * as cheerio from 'cheerio'
import { verifyPdf } from '../../lib/verifyPdf.js'
import { pickRegulaminFromDom } from '../../lib/pickRegulaminUrl.js'

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

function fold(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/gi, 'l').toLowerCase()
}

// Links the listing repeats on rows of different events. The organizer pastes
// one event's sign-up link into its neighbours, so a repeated link names at
// most one of them and has to earn its row before we store it.
function repeatedLinks(rows) {
  const owners = new Map()
  for (const r of rows) {
    if (!r.registration_url) continue
    if (!owners.has(r.registration_url)) owners.set(r.registration_url, new Set())
    owners.get(r.registration_url).add(r.source_id)
  }
  return new Set([...owners].filter(([, ids]) => ids.size > 1).map(([url]) => url))
}

// A registration page states which city it sells entries for in its <title>,
// e.g. "Pabianice, Poland 2026 - Rejestracja - ONWF".
function pageNamesCity($$, city) {
  if (!city) return false
  return fold($$('title').first().text()).includes(fold(city))
}

// Concession rates — a kids or disabled-entrant tier undercuts the general
// entry fee, and price_from has to be the fee a reader can actually pay.
const KIDS_TIER = /dzieci|młodzie[żz]|junior|kid/i
const DISABLED_TIER = /niepełnosprawn|niewidom|niedowidz/i
// An entry fee always names its distance. Add-ons on the same price ladder
// ("posiłek dla kibica - 30 PLN") do not, and must not become price_from.
const TIER_DISTANCE = /\d+(?:[.,]\d+)?\s*(?:km|m)\b/i

// ONWF tournament pages (poland.nordicwalkingworldleague.com) put both the
// price ladder and the registration close in .row.collapse-data pairs: a label
// or quota on the left, the value on the right.
function parseTournamentPage($$, { isKids = false } = {}) {
  const tiers = []
  let deadline = null

  $$('.row.collapse-data').each((_, row) => {
    const label = $$(row).children().not('.collapse-data-right').first().text().trim()
    const value = $$(row).find('.collapse-data-right').first().text().trim()
    if (!value) return

    if (fold(label) === 'zamkniecie rejestracji') {
      deadline = parseDeadline(value) || deadline
      return
    }

    // "Nordic Walking 20km - w biurze zawodów - 270 PLN" — the fee is the last
    // dash-separated part, everything before it names the category.
    const m = value.match(/^(.*)-\s*(\d+)\s*PLN$/)
    if (!m) return
    const category = m[1]
    if (!TIER_DISTANCE.test(category)) return
    if (DISABLED_TIER.test(category)) return
    if (!isKids && KIDS_TIER.test(category)) return
    tiers.push(parseInt(m[2], 10))
  })

  return {
    price_from: tiers.length > 0 ? Math.min(...tiers) : null,
    price_to: tiers.length > 0 ? Math.max(...tiers) : null,
    registration_deadline: deadline,
  }
}

// "16.08.2026 23:59" → "2026-08-16". A date we cannot read is dropped.
function parseDeadline(raw) {
  const m = (raw || '').match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/)
  if (!m) return null
  const [, dd, mm, yyyy] = m
  const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(dd)) return null
  return `${yyyy}-${mm}-${dd}`
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
  //
  // The same page also carries price and registration close, and is the only
  // place this source publishes them. Read both while we are there — but only
  // after the page has proven it belongs to this event, because a link the
  // listing repeats across rows points at one event's page and sells one
  // event's entries.
  const repeated = repeatedLinks(results)
  let withRegulamin = 0
  let withPrice = 0
  let foreign = 0
  for (const ev of newResults) {
    if (!ev.registration_url) continue
    try {
      await new Promise(r => setTimeout(r, 600))
      const res = await fetch(ev.registration_url, { headers: { 'User-Agent': UA } })
      if (!res.ok) continue
      const $$ = cheerio.load(await res.text())

      if (repeated.has(ev.registration_url) && !pageNamesCity($$, ev.location)) {
        if (ev.website === ev.registration_url) ev.website = null
        ev.registration_url = null
        foreign++
        continue
      }

      const candidate = pickRegulaminFromDom($$, {
        selector: 'a[href*=".pdf"]',
        baseUrl: ev.registration_url,
      })
      if (candidate && await verifyPdf(candidate)) {
        ev.regulamin_url = candidate
        withRegulamin++
      }

      const { price_from, price_to, registration_deadline } = parseTournamentPage($$, { isKids: ev.is_kids })
      if (price_from !== null) {
        ev.price_from = price_from
        ev.price_to = price_to
        withPrice++
      }
      if (registration_deadline) ev.registration_deadline = registration_deadline
    } catch (err) {
      console.error(`[maratonczykpomiarczasu] detail fetch failed for ${ev.source_id}:`, err.message?.slice(0, 80))
    }
  }
  console.log(`[maratonczykpomiarczasu] regulamin: ${withRegulamin}/${newResults.length} verified, price: ${withPrice}, foreign links dropped: ${foreign}`)

  return newResults
}

export { scrape, parseRows, repeatedLinks, parseTournamentPage }
