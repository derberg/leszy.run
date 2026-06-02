import * as cheerio from 'cheerio'

// pomiaryczasu.pl — "Pomiary Czasu", a multi-sport timing company (Silesia /
// Beskidy region: Ustroń, Ujsoły, Daleszyce, Kije, …). It hosts the canonical
// registration for its own events, so it's a direct organizer/timing co →
// priority tier 3.
//
// Listing: the homepage itself (server-rendered, no API, no pagination). All
// upcoming events live in a single `table.events_list` between the
// <a name="events_future"> and <a name="events_past"> anchors; the rows after
// the events_past anchor are finished events and are ignored.
//
// Row shapes inside the future block:
//   - month separator:  <tr><td colspan=6 class="month-header">Czerwiec 2026</td></tr>
//   - umbrella header:   <tr class="event-grouping-row"> date + umbrella name
//   - grouped sub-race:  <tr class="event-grouped-row"> date|name|type|details|signup|participants
//   - standalone event:  plain <tr> with the same 6 cells
// We collapse each umbrella + its grouped sub-races into ONE event (distances
// aggregated, event_types/is_kids mined across sub-races) so we don't publish a
// separate calendar row per distance.
//
// This is a MULTI-SPORT timing co — the "Typ zawodów" column carries road
// cycling ("Road Maraton" — confirmed: Pętla Beskidzka 54/108 km, Ujsoły Road
// Trophy + czasówka), MTB, downhill, cross-country SKIING ("Biegi narciarskie"
// — note: contains "Bieg" but is NOT running), triathlon, tourist rides, etc.
// So we WHITELIST the running types instead of blacklisting: only
// "Zawody Biegowe", "Nordic Walking" and "Bieg Przeszkodowy" (OCR) are kept.
// An umbrella is dropped if none of its sub-races is a running type.
//
// Per-event data:
//   - date / name / type        — listing row
//   - registration_url          — /registration/<slug>/ : the source's own
//                                  "Zapisz się" button href. Verified (curl -sIL,
//                                  body grep): returns 200, the event slug is
//                                  preserved through the auth round-trip and the
//                                  page reads "Zapisz się na <event>". Login is
//                                  required to complete sign-up (normal). Ruled
//                                  out reverse-engineering any other pattern —
//                                  this is what their UI exposes.
//   - source_url                — /event/<slug>/ detail page (public, no login)
//   - website                   — detail page "Strona www:" = organizer's
//                                  official site (a DECLARED link → kept even if
//                                  Facebook, per skill 5f; only pomiaryczasu's
//                                  own / asset hosts are stripped)
//   - distances                 — mined from sub-race names ("bieg 10 km",
//                                  "Nordic Walking 5 km", …); null when absent
// Location/voivodeship are not exposed anywhere → left for the geocoder.
// Prices / regulamin / deadline are not on the pages → left for the enricher.
const BASE_URL = 'https://www.pomiaryczasu.pl'
const LIST_URL = `${BASE_URL}/`
const USER_AGENT = 'leszy.run/1.0 (kontakt@leszy.run)'

// "Typ zawodów" values that are running (everything else — cycling, MTB,
// downhill, ski, triathlon, tourist — is dropped).
const RUNNING_TYPES = new Set(['zawody biegowe', 'nordic walking', 'bieg przeszkodowy'])

// Listing dates are "DD.MM.YYYY" (day/month may be single-digit). → YYYY-MM-DD.
function parseDate(raw) {
  if (!raw) return null
  const m = raw.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/)
  if (!m) return null
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

// ASCII slug from an umbrella name (for events with no own /event/ page). Same
// transliteration the site itself uses for slugs, so it stays deterministic.
function slugify(name) {
  const map = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }
  return (name || '')
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (c) => map[c] || c)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

// event_type tags from a text blob — mirrors distinguishingTags(). NW also keys
// off the Polish "marsz z kijami" / "marsz NW", since the English regex misses
// those.
function detectEventTypes(text) {
  const blob = (text || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|leśn[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b|marsz\s+z\s+kijami/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b|przeszkodow/i.test(blob)) tags.add('ocr')
  return [...tags]
}

// Map a "Typ zawodów" cell to a distinguishing tag (only the kept running types
// carry one beyond what the name reveals).
function typeColumnTag(type) {
  const t = (type || '').toLowerCase()
  if (t.includes('nordic')) return 'nordic walking'
  if (t.includes('przeszkod')) return 'ocr'
  return null
}

// is_kids — true if the umbrella name or any sub-race name carries a kids
// signal. JS \b doesn't recognize Polish letters, so use a manual non-letter
// boundary.
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

// Mine clean "N km" distances out of sub-race names; dedupe, preserve order.
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

// Parse one 6-cell event row → { name, date, type, detailUrl, regUrl, slug } or
// null if it's not an event row (thead, separators).
function parseEventRow($, tr) {
  const $tr = $(tr)
  const nameCell = $tr.find('.events_list-event_name')
  if (!nameCell.length) return null
  const name = nameCell.text().replace(/\s+/g, ' ').trim()
  const date = parseDate($tr.find('.events_list-event_start').text())
  const type = $tr.find('.events_list-type_name').text().replace(/\s+/g, ' ').trim()
  const detailUrl = $tr.find('.events_list-event_details a').attr('href') || null
  const regUrl = $tr.find('.events_list-event_signup a').attr('href') || null
  let slug = null
  if (detailUrl) {
    const m = detailUrl.match(/\/event\/([^/]+)\//)
    if (m) slug = m[1]
  }
  if (!name || !date) return null
  return { name, date, type, detailUrl, regUrl, slug }
}

// Walk the future block, grouping umbrella headers with their sub-races. Returns
// [{ umbrella, name, date, subs:[...] }].
function parseListing(html) {
  const $ = cheerio.load(html)
  const groups = []
  let group = null
  const flush = () => { if (group) { groups.push(group); group = null } }

  const rows = $('table.events_list tr').toArray()
  for (const tr of rows) {
    const $tr = $(tr)
    // Stop at the "Wyniki zawodów" (past events) section.
    if ($tr.find('a[name="events_past"]').length) break

    const cls = $tr.attr('class') || ''
    // Month separator — ends the current group, carries no event.
    if ($tr.find('td.month-header').length) { flush(); continue }

    // Umbrella header: <strong>date</strong> + <strong>name</strong>.
    if (/event-grouping-row/.test(cls)) {
      flush()
      const tds = $tr.find('td')
      const date = parseDate($(tds[0]).text())
      const name = $(tds[1]).text().replace(/\s+/g, ' ').trim()
      group = { umbrella: true, name, date, subs: [] }
      continue
    }

    const sub = parseEventRow($, tr)
    if (!sub) continue

    if (/event-grouped-row/.test(cls)) {
      if (group) group.subs.push(sub)
      else groups.push({ umbrella: false, name: sub.name, date: sub.date, subs: [sub] })
    } else {
      // Standalone event row — ends any open group.
      flush()
      groups.push({ umbrella: false, name: sub.name, date: sub.date, subs: [sub] })
    }
  }
  flush()
  return groups
}

// Fetch a detail page and read the organizer's "Strona www:" link.
async function fetchWebsite(detailUrl) {
  if (!detailUrl) return null
  try {
    const res = await fetch(detailUrl, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) return null
    const $ = cheerio.load(await res.text())
    let website = null
    $('.box-left-150').each((_, el) => {
      if (website) return
      if (/strona\s*www/i.test($(el).text())) {
        website = $(el).next('div').find('a[href^="http"]').attr('href') || null
      }
    })
    // Declared official link → keep even if Facebook (skill 5f). Only strip the
    // timing platform's own host and asset hosts.
    if (website && /pomiaryczasu\.pl|googleapis|gstatic/i.test(website)) website = null
    return website
  } catch (err) {
    console.error(`[pomiaryczasu] Detail fetch failed for ${detailUrl}:`, err.message)
    return null
  }
}

async function scrape({ knownIds = new Set() } = {}) {
  let groups = []
  try {
    const res = await fetch(LIST_URL, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) throw new Error(`listing ${res.status} ${res.statusText}`)
    groups = parseListing(await res.text())
  } catch (err) {
    console.error('[pomiaryczasu] Listing fetch failed:', err.message)
    return []
  }
  console.log(`[pomiaryczasu] Listing: ${groups.length} event groups parsed`)

  // Build event candidates (running-only), compute a deterministic source_id,
  // THEN drop ones already in the DB (detail page is fetched only for new rows,
  // so we never null a known row's website — timekeeper/zapisyvaldano pattern).
  const candidates = []
  for (const g of groups) {
    const keptSubs = g.subs.filter((s) => RUNNING_TYPES.has((s.type || '').toLowerCase()))
    if (keptSubs.length === 0) continue // no running sub-race → skip (cycling/ski/etc.)

    const rep = keptSubs[0]
    const date = g.date || rep.date
    if (!g.name || !date) continue

    // source_id: standalone → its real site slug; umbrella → slug of the
    // umbrella name (umbrellas have no own /event/ page).
    const sourceId = g.umbrella ? `grp_${slugify(g.name)}` : (rep.slug || slugify(g.name))

    candidates.push({
      sourceId,
      name: g.name,
      date,
      keptSubs,
      detailUrl: rep.detailUrl,
      regUrl: rep.regUrl,
    })
  }

  const newEntries = candidates.filter((e) => !knownIds.has(e.sourceId))
  console.log(`[pomiaryczasu] ${newEntries.length} new (skipping ${candidates.length - newEntries.length} known)`)

  const results = []
  for (const entry of newEntries) {
    const website = await fetchWebsite(entry.detailUrl)
    await new Promise((r) => setTimeout(r, 1100))

    const subNames = entry.keptSubs.map((s) => s.name)

    // event_types — default to the umbrella name; only mine sub-race signals
    // (name keywords + type column) when the umbrella name carries no style of
    // its own, to avoid {trail,nw}-style count mismatches with umbrella-only
    // aggregators (skill 5b exception).
    const umbrellaTypes = detectEventTypes(entry.name)
    let eventTypes
    if (umbrellaTypes.length) {
      eventTypes = umbrellaTypes
    } else {
      const t = new Set(detectEventTypes([entry.name, ...subNames].join(' ')))
      for (const s of entry.keptSubs) {
        const ct = typeColumnTag(s.type)
        if (ct) t.add(ct)
      }
      eventTypes = [...t]
    }

    const isKids = hasKidsSignal([entry.name, ...subNames].join(' '))
    const distances = extractDistances(subNames)

    results.push({
      name: entry.name,
      date: entry.date,
      location: null, // not exposed → geocoder
      distances,
      registration_url: entry.regUrl || null,
      registration_deadline: null, // enricher
      regulamin_url: null, // enricher
      website,
      is_kids: isKids,
      event_types: eventTypes.length ? eventTypes : null,
      price_from: null, // enricher
      price_to: null,
      source: 'pomiaryczasu',
      source_id: entry.sourceId,
      source_url: entry.detailUrl || null,
    })
    console.log(`[pomiaryczasu] ${results.length}/${newEntries.length} — ${entry.name}`)
  }

  console.log(`[pomiaryczasu] Scraped ${results.length} events`)
  return results
}

export { scrape, parseListing, parseDate, slugify, detectEventTypes, hasKidsSignal, extractDistances }
