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

// Links the listing puts on rows of more than one event. The organizer pastes
// one event's sign-up link into its neighbours, so a shared link belongs to at
// most one of them. Returns url → the rows contending for it.
function sharedLinks(rows) {
  const byUrl = new Map()
  for (const r of rows) {
    if (!r.registration_url) continue
    if (!byUrl.has(r.registration_url)) byUrl.set(r.registration_url, [])
    byUrl.get(r.registration_url).push(r)
  }
  const shared = new Map()
  for (const [url, contenders] of byUrl) {
    if (new Set(contenders.map(r => r.source_id)).size > 1) shared.set(url, contenders)
  }
  return shared
}

// A city has to be matched on words, not on its whole string: ONWF titles
// "Kostrzyn nad Odrą" as "Kostrzyn, Poland 2026", so requiring the full value
// would make the event that owns the page look like a stranger on it. Words
// under four letters ("nad", "i", "n.") name no city on their own.
function cityWords(city) {
  return fold(city).split(/[^a-z0-9]+/).filter(w => w.length >= 4)
}

function titleNamesCity(title, city) {
  const want = cityWords(city)
  if (want.length === 0) return false
  const have = fold(title).split(/[^a-z0-9]+/).filter(Boolean)
  return want.some(w => have.some(h => h.startsWith(w)))
}

// What a shared registration page says about the row we are holding. Only the
// <title> counts — the body lists clubs ("Walka Kostrzyn" is entered at
// Bełchatów), so body text names cities that are not selling anything.
//
//   'mine'    the title names this row's city and no other contender's
//   'foreign' it names exactly one contender, and that is not this row
//   'unknown' it names none of them, or several — no evidence either way
//
// 'unknown' is the answer for a link several rows legitimately share: a panel
// page titled with the event name alone, or a league hub listing every round.
// There we keep the link we were given and read nothing off the page, because
// a price that could belong to any of the rows belongs to none of them.
function ownership($$, ev, contenders) {
  const title = $$('title').first().text()
  const named = contenders.filter(c => titleNamesCity(title, c.location))
  if (named.length !== 1) return 'unknown'
  return named[0].source_id === ev.source_id ? 'mine' : 'foreign'
}

const ONWF_HOST = 'poland.nordicwalkingworldleague.com'
const ONWF_SEARCH = `https://${ONWF_HOST}/pl/tournaments/list/getEvents`

// The three league rounds the listing hands one round's link each have their
// own ONWF page; the listing just does not link it. ONWF's event search takes a
// city, so ask it for this row's city and accept a hit only when the row it
// returns carries this row's date and the page it points at is titled with this
// row's city. Anything less is a guess, and a guess is not an answer.
async function resolveOwnTournamentPage(ev) {
  if (!ev.location) return null
  const res = await fetch(ONWF_SEARCH, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: ev.location, cycleId: 'all', page: '1', grade: '[]' }).toString(),
  })
  if (!res.ok) return null
  const $ = cheerio.load(await res.text())

  let href = null
  $('.row.signin-data').each((_, row) => {
    if (href) return
    const dates = $(row).text().match(/\d{4}-\d{2}-\d{2}/g) || []
    if (!dates.includes(ev.date)) return
    $(row).find('a[href*="/tournaments/"]').each((_, a) => {
      const h = $(a).attr('href') || ''
      if (!href && !h.includes('/applications')) href = h
    })
  })
  if (!href) return null

  const url = new URL(href, `https://${ONWF_HOST}`).toString()
  const page = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!page.ok) return null
  const $$ = cheerio.load(await page.text())
  if (!titleNamesCity($$('title').first().text(), ev.location)) return null
  return { url, $: $$ }
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
    // dash-separated part, everything before it names the category. Grosze are
    // written with a comma ("85,00 PLN") and are still a fee.
    const m = value.match(/^(.*)-\s*(\d+(?:[.,]\d{1,2})?)\s*PLN$/)
    if (!m) return
    const category = m[1]
    if (!TIER_DISTANCE.test(category)) return
    if (DISABLED_TIER.test(category)) return
    if (!isKids && KIDS_TIER.test(category)) return
    tiers.push(Number(m[2].replace(',', '.')))
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
  // off a page that has proven it belongs to this event, because a link the
  // listing puts on several rows points at one event's page and sells one
  // event's entries.
  const shared = sharedLinks(results)
  let withRegulamin = 0
  let withPrice = 0
  let reassigned = 0
  let dropped = 0
  let ambiguous = 0
  for (const ev of newResults) {
    if (!ev.registration_url) continue
    try {
      await new Promise(r => setTimeout(r, 600))
      const res = await fetch(ev.registration_url, { headers: { 'User-Agent': UA } })
      if (!res.ok) continue
      let $$ = cheerio.load(await res.text())
      let pageUrl = ev.registration_url

      const contenders = shared.get(ev.registration_url)
      if (contenders) {
        const verdict = ownership($$, ev, contenders)
        if (verdict === 'unknown') {
          // No evidence the page is anyone else's. Keep the link the listing
          // gave us — deleting a field on a hunch is worse than the blank it
          // would fill — and take nothing off a page we cannot attribute.
          ambiguous++
          continue
        }
        if (verdict === 'foreign') {
          const own = await resolveOwnTournamentPage(ev)
          if (!own) {
            ev.registration_url = null
            dropped++
            continue
          }
          ev.registration_url = own.url
          pageUrl = own.url
          $$ = own.$
          reassigned++
        }
      }

      const candidate = pickRegulaminFromDom($$, {
        selector: 'a[href*=".pdf"]',
        baseUrl: pageUrl,
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
  console.log(`[maratonczykpomiarczasu] regulamin: ${withRegulamin}/${newResults.length} verified, price: ${withPrice}, shared links: ${reassigned} repointed, ${dropped} dropped, ${ambiguous} left alone`)

  return newResults
}

export { scrape, parseRows, sharedLinks, titleNamesCity, parseTournamentPage }
