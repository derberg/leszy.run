// Pifsport (pifsport.com.pl) — Małopolska/Podkarpacie timing company
// ("Pomiar czasu, organizacja imprez sportowo-rekreacyjnych").
//
// Data source: WordPress REST posts API. Events are blog posts under the
// "aktualne imprezy" category (id 5). The full post HTML (content.rendered)
// is returned by the LIST endpoint, so EVERY field — semi-structured prose
// (data:/miejsce:/konkurencja:) and the registration/regulamin button hrefs —
// comes from one paginated API call. No per-event detail fetches needed
// (sporttime-style "emit all, no detail" pattern; re-emitting is idempotent
// and no field can be nulled by re-emitting, since all fields are re-derived
// from the same response each run).
//
// Pifsport does a LOT of cross-country SKI timing (biegi narciarskie); those
// posts share the category with running events and MUST be filtered out here —
// the merge-stage SKIP_KEYWORDS list does not cover skiing.
//
// Date typos: the organizer occasionally types the wrong year. The CONTENT
// body "data:" field is the most reliable (it's the cleaned official date);
// the EXCERPT and TITLE sometimes carry a stale year. Resolution order is
// content data: → excerpt data: → content/excerpt termin: → title → slug.
// This drops genuinely-past events whose TITLE was typo'd to a future year
// (e.g. "Bieg Bejorów … Rytro 26.10.2026r." whose body says 26.10.2025r.)
// while keeping future events whose EXCERPT was typo'd to a past year.
//
// URL verification: registration_url is taken from the source's own
// "LINK do ZGŁOSZEŃ" / "Zarejestruj się" button href (the approach mandated
// by CLAUDE.md — scrape the source's own button, don't reverse-engineer).
// Verified e-gepard.eu/show-contest/<id> resolves 200 with event-specific
// content (contest 1663 → "JEDLICKA"). regulamin PDFs are hosted on
// pifsport's own server (trusted). registration host is whitelisted so route
// maps (flow.polar.com, connect.garmin.com) and result PDFs are never picked.

import * as cheerio from 'cheerio'

const POSTS_URL = 'https://pifsport.com.pl/wp-json/wp/v2/posts'
const ACTIVE_CATEGORY = 5 // "aktualne imprezy"
const UA = 'leszy.run/1.0 (kontakt@leszy.run)'

// Online registration platforms pifsport links out to. A href must match one
// of these to be considered a registration URL — this excludes route-map links
// (flow.polar.com, connect.garmin.com), federation sites (srs.szs.pl) and the
// paper-form PDFs/DOCs hosted on pifsport itself.
const REG_HOST = /e-gepard\.eu|docs\.google\.com\/forms|dostartu\.pl|elektronicznezapisy\.pl|b4sport|datasport\.pl|protiming|enduhub|mktime|o-timing|\bzapisy[a-z0-9.-]*\.pl/i

// Skiing / winter events — pifsport's other big line of business. Not running.
const SKI_RE = /narciar|narciarstw|biathlon|skiroll|nartoroll|biegi\s+narciarskie/i

// \b doesn't recognize Polish letters in JS — use a manual non-letter boundary
const NB = '[^a-ząćęłńóśźż]'

function decode(htmlStr) {
  return cheerio.load(`<div>${htmlStr || ''}</div>`)('div').text().replace(/\s+/g, ' ').trim()
}

function detectEventTypes(blob) {
  const s = (blob || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|le[sś]n[aey]|\btrail\b|cross(?:owy|owa|owe)?\b|prze[lł]aj/i.test(s)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b|marsz\s+z\s+kijami|marsz\s+nw/i.test(s)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(s)) tags.add('ultra')
  if (/\bocr\b|przeszkod/i.test(s)) tags.add('ocr')
  if (/uliczn/i.test(s)) tags.add('uliczny')
  return [...tags]
}

function hasKidsSignal(blob) {
  if (!blob) return false
  const s = ` ${blob.toLowerCase()} `
  if (/(?:biegi|bieg|dla)\s+dzieci/.test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}świetlik`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

// "06.06.2026r." / "6.06.26r." / "21.06.2026r. godz. 9.15" → "2026-06-06"
function parsePolishDate(text) {
  if (!text) return null
  const m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/)
  if (!m) return null
  let [, d, mo, y] = m
  if (y.length === 2) y = `20${y}`
  d = d.padStart(2, '0')
  mo = mo.padStart(2, '0')
  const mm = +mo, dd = +d, yy = +y
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || yy < 2020 || yy > 2099) return null
  return `${y}-${mo}-${d}`
}

// Pull the value following a prose label and parse the first date in it.
function dateFromLabel(text, label) {
  const m = text.match(new RegExp(`${label}\\s*:?\\s*(.{0,40})`, 'i'))
  return m ? parsePolishDate(m[1]) : null
}

// Extract the prose segment after `konkurencja:` (bounded so the next field
// doesn't bleed in), for distance + type detection.
function konkurencjaText(text) {
  const m = text.match(/konkurencj[ae]\s*:?\s*(.{0,250})/i)
  return m ? m[1] : ''
}

// "Biegi na 5km oraz 10 km" → "5 km, 10 km"; "Długość: 6,5 km" → "6.5 km".
// Strips elevation phrases ("Przewyższenie: 230 m") so they aren't mistaken
// for distances.
function extractDistances(text) {
  if (!text) return null
  const cleaned = text.replace(/przewy[żz]szeni[ea][^.]*?\d+\s*m\b/gi, ' ')
  const out = []
  const seen = new Set()
  const re = /(\d{1,4}(?:[.,]\d{1,2})?)\s*(km|m)\b/gi
  let m
  while ((m = re.exec(cleaned))) {
    const unit = m[2].toLowerCase()
    const val = parseFloat(m[1].replace(',', '.'))
    if (unit === 'km' && (val <= 0 || val > 300)) continue
    if (unit === 'm' && (val < 30 || val > 5000)) continue
    const key = `${val}${unit}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(`${m[1].replace(',', '.')} ${unit}`)
  }
  return out.length ? out.join(', ') : null
}

// City from the `miejsce:` prose. Take the value, drop leading START/META/
// venue noise, take the first segment before a comma/dash. Best-effort — the
// pipeline geocodes voivodeship from whatever city string we emit; garbage
// just leaves voivodeship empty for the enricher.
function parseLocation(text) {
  const m = text.match(/miejsce\s*:?\s*(.{0,80})/i)
  if (!m) return null
  let v = m[1]
    .replace(/\borganizator\b[\s\S]*$/i, '')
    .replace(/\bstatus\b[\s\S]*$/i, '')
    .replace(/\bkonkurencj[ae]\b[\s\S]*$/i, '')
    .replace(/^(start|meta|teren)\s*[-–:]?\s*/i, '')
    .split(',')[0]
    .split(/\s*[–-]\s*/)[0]
    .replace(/\bul\.?\s.*$/i, '')
    .trim()
  if (!v || v.length > 40) return null
  // Region-only mentions aren't cities — let geocoding fall back to enricher
  if (/^(ma[lł]opolska|podkarpacie|śląsk|małopolskie|podkarpackie)$/i.test(v)) return null
  return v
}

async function fetchPage(page) {
  const url = `${POSTS_URL}?categories=${ACTIVE_CATEGORY}&per_page=100&page=${page}&_fields=id,date,slug,link,title,excerpt,content,categories`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`posts API page ${page} returned ${res.status}`)
  const totalPages = parseInt(res.headers.get('x-wp-totalpages') || '1', 10)
  const posts = await res.json()
  return { posts, totalPages }
}

export async function scrape({ knownIds = new Set() } = {}) {
  const today = new Date().toISOString().split('T')[0]
  const results = []
  let skiSkipped = 0
  let noDate = 0
  let pastDate = 0

  try {
    let page = 1
    let totalPages = 1
    const allPosts = []
    do {
      const { posts, totalPages: tp } = await fetchPage(page)
      totalPages = tp
      allPosts.push(...posts)
      page += 1
    } while (page <= totalPages && page <= 6)

    console.log(`[pifsport] Fetched ${allPosts.length} posts from category ${ACTIVE_CATEGORY}`)

    for (const post of allPosts) {
      const title = decode(post.title?.rendered)
      if (!title) continue

      const contentText = decode(post.content?.rendered)
      const excerptText = decode(post.excerpt?.rendered)
      const slugText = (post.slug || '').replace(/-/g, '.')
      const blob = `${title} ${konkurencjaText(contentText)} ${konkurencjaText(excerptText)}`

      // Skip skiing / winter events — not running
      if (SKI_RE.test(`${title} ${contentText}`)) {
        skiSkipped += 1
        continue
      }

      // Date: content data: → excerpt data: → termin: → title → slug
      const date =
        dateFromLabel(contentText, 'data') ||
        dateFromLabel(excerptText, 'data') ||
        dateFromLabel(contentText, 'termin') ||
        dateFromLabel(excerptText, 'termin') ||
        parsePolishDate(title) ||
        parsePolishDate(slugText)

      if (!date) {
        noDate += 1
        continue
      }
      if (date < today) {
        pastDate += 1
        continue
      }

      // Registration + regulamin from the post body buttons
      const $ = cheerio.load(post.content?.rendered || '')
      const regCandidates = []
      let regulaminUrl = null
      $('a').each((_, a) => {
        const href = $(a).attr('href') || ''
        if (!/^https?:/i.test(href)) return
        const txt = $(a).text().replace(/\s+/g, ' ').trim().toLowerCase()
        if (!regulaminUrl && /regulamin/.test(txt) && /\.pdf(\?|$)/i.test(href)) {
          regulaminUrl = href
        }
        const isResults = /wynik|lista\s+startowa|ranking|klasyfikacj|plakat|szkic|mapa|trasa/.test(txt)
        if (REG_HOST.test(href) && !isResults) regCandidates.push(href)
      })
      // Prefer e-gepard (pifsport's main platform) over a child Google Form etc.
      const registrationUrl =
        regCandidates.find((h) => /e-gepard\.eu/i.test(h)) || regCandidates[0] || null

      // Registration deadline ("zgłoszenia do dnia 08.06.26r.") — optional;
      // only kept if sane (on/before the event date).
      let deadline = dateFromLabel(contentText, 'zg[łl]oszeni\\w*\\s+do(?:\\s+dnia)?')
      if (!deadline) deadline = dateFromLabel(excerptText, 'zg[łl]oszeni\\w*\\s+do(?:\\s+dnia)?')
      if (deadline && deadline > date) deadline = null

      const konk = `${konkurencjaText(contentText)} ${konkurencjaText(excerptText)} ${title}`
      const distances = extractDistances(konk)
      const location = parseLocation(contentText) || parseLocation(excerptText)
      const eventTypes = detectEventTypes(blob)
      const isKids = hasKidsSignal(blob)

      results.push({
        name: title,
        date,
        location: location || null,
        distances: distances || null,
        registration_url: registrationUrl,
        registration_deadline: deadline || null,
        regulamin_url: regulaminUrl,
        website: null,
        is_kids: isKids,
        event_types: eventTypes,
        price_from: null,
        price_to: null,
        source: 'pifsport',
        source_id: String(post.id),
        source_url: post.link || null,
      })
    }

    console.log(
      `[pifsport] Scraped ${results.length} future running events ` +
        `(skipped: ${skiSkipped} skiing, ${noDate} no-date, ${pastDate} past)`
    )
  } catch (err) {
    console.error(`[pifsport] Scrape failed: ${err.message}`)
  }

  return results
}
