import * as cheerio from 'cheerio'

// e-gepard.eu — a multi-sport timing / online-registration company (operated by
// RFID.Zone Sp. z o.o.). It hosts the canonical registration for its own events,
// so it's a direct organizer/timing co → priority tier 3.
//
// Listing: /pl/list-contest-all is a single server-rendered table (Laravel app,
// NOT WordPress — no wp-json / iCal). Rows: <a href=".../show-contest/<id>">name</a>
// | organizer | date (YYYY-MM-DD, machine-readable) | place(city). The list is
// sorted date-descending, contains ALL events (past + future) and is capped at
// 1000 rows by the server, so we ask for pageSize=500 (future events sit at the
// top) and filter to date >= today ourselves to avoid fetching ~970 past detail
// pages.
//
// This is a MULTI-SPORT platform — alongside running it hosts road cycling
// ("GRAND PRIX … NA SZOSIE - rajd", "MASA KRYTYCZNA"), open-water / ice swimming
// ("OPEN WATER", "INWAZJA MORSUJĄCYCH MIKOŁAJÓW"), cross-country SKIING
// ("narciarstwie biegowym" — contains "bieg" but is NOT running), and
// du-/triathlon. The listing has no sport-type column, so we BLACKLIST those by
// name keyword (a whitelist is unsafe: event names vary wildly — "Festiwal
// Sportowy", "W RYTMIE SERCA NA PIĄTKĘ", …). The blacklist keywords never appear
// in plain running events.
//
// Per-event data comes from the detail page /pl/show-contest/<id>:
//   - Miejsce (city) / Organizator / Data zawodów  — "Dane zawodów" th/td table
//   - regulamin_url   — first external (non-e-gepard) link inside the Opis cell;
//                       prefer a .pdf. Often hosted on the organizer's own site
//                       (pifsport.com.pl, osir.swinoujscie.pl, …). Null when the
//                       Opis only contains inline regulamin prose.
//   - competition names + "Zapis do" dates — the #racesTable sub-race list. Used
//                       for distances, event_types, is_kids and the registration
//                       deadline (max "Zapis do" that is <= the event date — some
//                       sub-races carry a bogus past-the-event placeholder).
//   - registration_url = source_url = the show-contest/<id> page itself. e-gepard
//                       IS the registration host: a future competition's status
//                       reads "udostępnione do rejestracji" and its "Rejestracja"
//                       button drives the e-gepard sign-up flow (login required —
//                       normal). The contest URL is e-gepard's own, carries the
//                       stable numeric id, and survives the auth round-trip. Same
//                       canonical-detail-page-as-registration-URL model as
//                       zapisyvaldano. Verified: curl show-contest/<id> returns
//                       the named event + its competitions; ruled out reverse-
//                       engineering any per-event external URL (running events
//                       expose none — only the cycling rajds link out, and those
//                       are blacklisted).
// Distances are only present where a competition/event name spells them out
// ("Bieg 5 km") → mined, else null. Prices are nowhere on the platform → enricher.
// Location voivodeship is not exposed → geocoder fills it from the city.
const BASE_URL = 'https://www.e-gepard.eu'
const LIST_URL = `${BASE_URL}/pl/list-contest-all?pageSize=500`
const USER_AGENT = 'leszy.run/1.0 (kontakt@leszy.run)'

// Non-running sport keywords. Matched against the event name (from the listing).
// These never occur in plain running-event names on this source.
const NON_RUNNING = /na szosie|\brajd\b|masa krytyczna|open water|morsuj|wp[lł]aw|p[lł]ywack|narciar|biathlon|\bmtb\b|kolarsk|rowerow|gravel|triathlon|duathlon|aquathlon|kajak/i

// event_type tags from a text blob — mirrors distinguishingTags(). NW also keys
// off the Polish "marsz z kijami" / "marsz NW", since the English regex misses it.
function detectEventTypes(text) {
  const blob = (text || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|leśn[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b|marsz\s+z\s+kijami/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b|przeszkodow/i.test(blob)) tags.add('ocr')
  return [...tags]
}

// is_kids — true if the event name or any sub-race name carries a kids signal.
// JS \b doesn't recognize Polish letters, so use a manual non-letter boundary.
const NB = '[^a-ząćęłńóśźż]'
function hasKidsSignal(text) {
  if (!text) return false
  const s = ` ${text.toLowerCase()} `
  if (/(?:biegi|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}świetlik`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

// Mine clean "N km" distances out of name + sub-race names; dedupe, keep order.
function extractDistances(texts) {
  const found = []
  const seen = new Set()
  for (const t of texts || []) {
    const re = /(\d+(?:[.,]\d+)?)\s*km\b/gi
    let m
    while ((m = re.exec(t)) !== null) {
      const norm = `${m[1].replace(',', '.')} km`
      if (!seen.has(norm)) { seen.add(norm); found.push(norm) }
    }
  }
  return found.length ? found.join(', ') : null
}

// Parse the listing table → [{ id, name, date, city }], future + running only.
function parseListing(html, today) {
  const $ = cheerio.load(html)
  const out = []
  $('a[href*="/show-contest/"]').each((_, a) => {
    const href = $(a).attr('href') || ''
    const m = href.match(/\/show-contest\/(\d+)/)
    if (!m) return
    const $tr = $(a).closest('tr')
    const tds = $tr.find('td')
    if (tds.length < 4) return
    const name = $(a).text().replace(/\s+/g, ' ').trim()
    const date = $(tds[2]).text().trim()
    const city = $(tds[3]).text().replace(/\s+/g, ' ').trim()
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return
    if (date < today) return // past → skip (pipeline would drop anyway)
    if (NON_RUNNING.test(name)) return // cycling / swimming / ski / triathlon
    out.push({ id: m[1], name, date, city: city || null })
  })
  return out
}

// Parse a detail page → { city, regulamin, subNames, deadline }.
function parseDetail(html, eventDate) {
  const $ = cheerio.load(html)

  // "Dane zawodów" th/td table (the #basic tab table).
  const data = {}
  let opisCell = null
  $('#basic table tr').each((_, tr) => {
    const th = $(tr).find('th').first()
    const td = $(tr).find('td').first()
    if (!th.length || !td.length) return
    const label = th.text().replace(/\s+/g, ' ').trim()
    data[label] = td.text().replace(/\s+/g, ' ').trim()
    if (/^Opis/i.test(label)) opisCell = td
  })
  const city = data['Miejsce'] || null

  // regulamin: the first external (non-e-gepard) .pdf link in the Opis cell. On
  // this source the Opis mixes regulamin PDFs (often on the organizer's own site)
  // with privacy pages and bare organizer homepages, so we accept ONLY PDFs and
  // skip privacy/policy docs — an HTML link here is unreliable as a regulamin, so
  // we leave those for the enricher rather than write a wrong URL to the DB.
  let regulamin = null
  if (opisCell) {
    opisCell.find('a[href]').each((_, el) => {
      if (regulamin) return
      const href = $(el).attr('href') || ''
      if (!/^https?:\/\//i.test(href)) return
      if (/e-gepard\.eu/i.test(href)) return
      if (!/\.pdf($|\?)/i.test(href)) return
      if (/polityka|prywatnosci|ochrona-danych|rodo/i.test(href)) return
      regulamin = href
    })
  }

  // Competition list (#racesTable): rows that link to a show-race page. Cells:
  // [name, limit, zapis_do, płatność_do, godzina, zapłaconych].
  const subNames = []
  const deadlines = []
  $('#racesTable tr').each((_, tr) => {
    if (!$(tr).find('a[href*="/show-race/"]').length) return
    const cells = $(tr).find('td').map((_, td) => $(td).text().replace(/\s+/g, ' ').trim()).get()
    const named = cells.filter((c) => c)
    if (!named.length) return
    subNames.push(named[0])
    const zapis = cells[2]
    if (zapis && /^\d{4}-\d{2}-\d{2}$/.test(zapis) && zapis <= eventDate) deadlines.push(zapis)
  })
  const deadline = deadlines.length ? deadlines.sort().slice(-1)[0] : null

  return { city, regulamin, subNames, deadline }
}

async function scrape({ knownIds = new Set() } = {}) {
  // knownIds is accepted for the pipeline contract but intentionally ignored: we
  // re-fetch every future event's detail page each run (only ~15-30 of them), so
  // the registration deadline / regulamin stay fresh and no field is ever nulled
  // by a partial re-emit (all output comes from the detail fetch).
  void knownIds

  const today = new Date().toISOString().slice(0, 10)

  let events = []
  try {
    const res = await fetch(LIST_URL, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) throw new Error(`listing ${res.status} ${res.statusText}`)
    events = parseListing(await res.text(), today)
  } catch (err) {
    console.error('[egepard] Listing fetch failed:', err.message)
    return []
  }
  console.log(`[egepard] Listing: ${events.length} future running events`)

  const results = []
  for (const ev of events) {
    const detailUrl = `${BASE_URL}/pl/show-contest/${ev.id}`
    let detail = { city: null, regulamin: null, subNames: [], deadline: null }
    try {
      const res = await fetch(detailUrl, { headers: { 'User-Agent': USER_AGENT } })
      if (res.ok) detail = parseDetail(await res.text(), ev.date)
      else console.error(`[egepard] Detail ${ev.id} → ${res.status}`)
    } catch (err) {
      console.error(`[egepard] Detail fetch failed for ${ev.id}:`, err.message)
    }
    await new Promise((r) => setTimeout(r, 1100))

    const subNames = detail.subNames
    const blob = [ev.name, ...subNames].join(' ')

    // event_types — default to the umbrella (event) name; only mine sub-race
    // signals when the umbrella name carries no style of its own, to avoid
    // {trail,nw}-style count mismatches with umbrella-only aggregators (skill 5b).
    const umbrellaTypes = detectEventTypes(ev.name)
    const eventTypes = umbrellaTypes.length ? umbrellaTypes : detectEventTypes(blob)

    results.push({
      name: ev.name,
      date: ev.date,
      location: detail.city || ev.city || null,
      distances: extractDistances([ev.name, ...subNames]),
      registration_url: detailUrl, // e-gepard is the registration host
      registration_deadline: detail.deadline || null,
      regulamin_url: detail.regulamin || null,
      website: null, // enricher
      is_kids: hasKidsSignal(blob),
      event_types: eventTypes.length ? eventTypes : null,
      price_from: null, // enricher
      price_to: null,
      source: 'egepard',
      source_id: ev.id,
      source_url: detailUrl,
    })
    console.log(`[egepard] ${results.length}/${events.length} — ${ev.name}`)
  }

  console.log(`[egepard] Scraped ${results.length} events`)
  return results
}

export { scrape, parseListing, parseDetail, detectEventTypes, hasKidsSignal, extractDistances }
