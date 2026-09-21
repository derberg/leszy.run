// Deterministic regulamin (rules document) discovery on the row's OWN
// registration page.
//
// WHY THIS EXISTS
// The search step asks Claude to find a regulamin with web queries, but the
// registration page is already known on the row and Polish timing platforms
// link the regulamin straight from it. Reading a page we already have costs
// nothing; a web search costs money and can come back empty.
//
// WYSPOWY ULTRA ŚWIR (2027-06-26, biegigorskie:wyspowy-ultra-swir-2027-06-26)
// is the case that showed it. Its registration_url is
// https://b4sportonline.pl/ultra_swir/, which links the regulamin three times,
// once per distance. The search ran on 2026-09-21, found nothing, and the row
// published with regulamin_url, price_from and price_to all null — prices are
// mined from the regulamin, so a missing regulamin empties them too. Measured
// 2026-09-21: 42 future scraper_all rows had been through the search step with
// a known registration_url and no regulamin_url.
//
// AMBIGUITY IS THE WHOLE PROBLEM
// A b4sport organizer page hosts several editions of a race side by side, and
// biegigorskie sets registration_url to whatever the sign-up cell links — the
// organizer landing page — so two of our rows can carry the SAME
// registration_url. "This page links a Regulamin" is therefore not "this page
// links THIS event's regulamin", not even when it links exactly one. Two
// guards, in this order:
//
//   1. ATTRIBUTION. A candidate is only this row's if the section of the page
//      it sits in names this event (or, failing that, its city) better than
//      any section standing beside it does. This is the same question
//      b4sport.js pickRegulamin() asks, and it is what keeps the autumn
//      edition's rules off the June row even when they are the only rules on
//      the page — a lone candidate still has to beat the Wyspowy section it is
//      sitting next to.
//   2. ONE DOCUMENT. Whatever survives attribution must resolve to a single
//      document: every survivor is fetched and compared byte for byte. Three
//      links to the same file is one document, which is exactly what
//      ultra_swir publishes (all three .odt files share an md5). Two different
//      files is a choice the markup cannot make for us.
//
// Either guard failing returns null and leaves it to the web search. A null
// regulamin costs one empty field; the wrong edition's regulamin costs every
// field the next enricher reads out of it.

import { createHash } from 'crypto'
import * as cheerio from 'cheerio'
import { scoreRegulaminCandidate } from '../../src/lib/pickRegulaminUrl.js'
// The naming rules that tell two races on one organizer's site apart already
// exist, in the scraper that needed them first. Sharing them keeps one
// definition of "a distinctive token of this event's name".
import { nameTokens, citySlug } from '../../src/scrapers/sources/b4sport.js'

const UA = 'leszy.run/1.0 (kontakt@leszy.run)'

// A regulamin may also be a plain HTML page, but on a registration page every
// link is an HTML page, so "it is a document" is what separates the rules file
// from the sign-up form and the results list. This is why the step cannot help
// a platform that serves its rules from an extensionless download URL
// (elektronicznezapisy's /download/<hash>/open) — there the markup gives us
// nothing to separate the two.
const DOCUMENT = /\.(pdf|odt|docx?|rtf)($|[?#])/i

// Elements that label the block that follows them. A b4sport organizer menu
// introduces each edition with a bare <a> above the <ul> of its distances;
// other sites use a heading. An <li> is deliberately NOT a label: the <li>
// before ours is the sibling edition, and pulling its text in is the exact
// confusion this is here to prevent.
const SECTION_LABEL = 'a,h1,h2,h3,h4,h5,h6,strong,b,summary,dt,legend,caption,th'

// Far enough to climb out of a nested menu, short of the whole page. Climbing
// to <body> would give every candidate the same context and tell us nothing.
const MAX_SECTION_DEPTH = 8

// The fingerprint only has to tell two documents apart. verifyPdf.js gets away
// with a HEAD; we cannot, because we compare bytes — so we cap what we pull
// down instead. Two regulamins that agree on their first 2 MB are one document
// as far as this step is concerned.
const MAX_DOC_BYTES = 2 * 1024 * 1024

/**
 * Read a link's place on the page, as two things:
 *
 *   own    — the link's own href and text plus the nearest label above each
 *            block enclosing it. On ultra_swir that reads "Regulamin" ←
 *            "Bieg 43 km" ← "Wyspowy Ultra Świr 2027": the edition the document
 *            is filed under.
 *   rivals — the labels of the blocks standing BESIDE those, which is what a
 *            page hosting more than one event looks like. "Jesienny ULTRA ŚWIR"
 *            is a rival of the link above.
 *
 * A label above us describes us (a page heading covers everything under it); a
 * label inside the block next to us describes something else. That is the whole
 * distinction, and it is what lets a single regulamin on a two-edition page be
 * refused.
 *
 * Both sides are normalised the way b4sport normalises its haystacks.
 */
function readSection($, a) {
  const href = $(a).attr('href') || ''
  let decoded = href
  try { decoded = decodeURIComponent(href) } catch { /* leave it encoded */ }
  const own = [decoded, $(a).text()]
  const rivals = []
  let branch = $(a)
  for (let depth = 0; depth < MAX_SECTION_DEPTH; depth++) {
    const label = branch.prevAll(SECTION_LABEL).first()
    if (label.length) own.push(label.text())
    branch.siblings().not(SECTION_LABEL).each((_, block) => {
      $(block).find(SECTION_LABEL).each((__, l) => rivals.push(citySlug($(l).text())))
    })
    branch = branch.parent()
    if (!branch.length || branch[0].tagName === 'body') break
  }
  const text = own.join(' ')
  return {
    own: citySlug(text),
    // Editions of one race most often differ by nothing but the year, which
    // nameTokens() drops on purpose (a bare number tells two races apart about
    // as often as it confuses them). Kept separately so it can be checked
    // against the row's date, on text that still has its word boundaries.
    years: [...new Set(text.match(/\b20\d{2}\b/g) || [])],
    rivals: rivals.filter(Boolean),
  }
}

/**
 * Collect the document links on a page that declare themselves a regulamin,
 * in DOM order, absolute and deduplicated. Each carries the section it sits in
 * so it can be attributed to a row later.
 *
 * The href alone is not enough: b4sport stores uploads under an opaque hash
 * (/users-folder/1104/files/63269af0….odt), so only the anchor text says what
 * the file is. scoreRegulaminCandidate applies the project rule — a link is
 * the regulamin only if it says so, and never an oświadczenie, a klauzula RODO
 * or a course map.
 *
 * @param {string} html
 * @param {string} baseUrl  resolve relative hrefs against this
 * @returns {Array<{url: string, own: string, years: string[], rivals: string[]}>}
 */
export function collectRegulaminDocLinks(html, baseUrl) {
  const $ = cheerio.load(html)
  const seen = new Set()
  const out = []

  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') || '').trim()
    if (!href || !DOCUMENT.test(href)) return
    const score = scoreRegulaminCandidate({ href, text: $(a).text() })
    if (score === null || score < 1) return

    let url
    try { url = new URL(href, baseUrl).toString() } catch { return }
    if (seen.has(url)) return
    seen.add(url)
    out.push({ url, ...readSection($, a) })
  })

  return out
}

/**
 * Keep only the candidates this row can claim.
 *
 * The same two tiers b4sport.js pickRegulamin() uses — distinctive tokens of
 * the event's name, then the city — but asked against the page's own sections
 * rather than only against the other candidates. That difference is the point.
 * pickRegulamin() picks the best of a set gathered FOR an event, so a lone
 * candidate is safe to take. Here nothing promises this row's regulamin is on
 * the page at all: the page may host a sibling edition and carry only ITS
 * rules, and a lone candidate would sail through any comparison between
 * candidates. So no rival section beside a candidate may name our row BETTER
 * than the section holding it does — "Wyspowy Ultra Świr 2027" beats "Jesienny
 * ULTRA ŚWIR", and the autumn edition's lone regulamin loses to the Wyspowy
 * section it sits next to. A tie is not held against a candidate: on a
 * one-event page the page title repeats the event name, and that is the page
 * agreeing with us, not a rival.
 *
 * Ties are where the year earns its place. Two editions of one race differ by
 * nothing else, so a section that names a year has to name this row's.
 *
 * @param {Array<{url: string, own: string, years: string[], rivals: string[]}>} candidates
 * @param {object} row  needs name and date, and location for the city tier
 * @returns {Array} the subset this row can claim, possibly empty
 */
export function attributableCandidates(candidates, row) {
  const year = String(row?.date || '').slice(0, 4)
  // A section that dates itself has to agree with the row. One that names no
  // year at all says nothing either way and is left to the name tiers.
  const rightYear = c => !year || c.years.length === 0 || c.years.includes(year)
  const dated = candidates.filter(rightYear)

  const tokens = nameTokens(row?.name)
  if (tokens.length > 0) {
    const hits = hay => tokens.filter(t => hay.includes(t)).length
    const named = dated.filter(c => {
      const own = hits(c.own)
      return own > 0 && c.rivals.every(r => hits(r) <= own)
    })
    if (named.length > 0) return named
  }

  // Tier 2: city, for a multi-city series that names its files by town. Two
  // letters would match half the page, so require a real name.
  const city = citySlug(row?.location)
  if (city.length >= 3) {
    const placed = dated.filter(c =>
      c.own.includes(city) && !c.rivals.some(r => r.includes(city)))
    if (placed.length > 0) return placed
  }

  return []
}

/**
 * Fetch a URL and consume its body, all under one abort timer. The timer has
 * to outlive the headers: fetch() resolves as soon as the response line is in,
 * so clearing it there leaves a server that sends headers and then stalls on
 * the body free to hang the whole run.
 *
 * @param {Function} consume  (res, contentType) => value|null, awaited inside
 */
async function fetchWithin(url, { fetchImpl, timeoutMs }, consume) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA },
    })
    if (!res.ok) return null
    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    return await consume(res, contentType)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Read at most `limit` bytes of a response body, then hang up. */
async function readCapped(res, limit) {
  const reader = res.body?.getReader?.()
  if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, limit)

  const chunks = []
  let total = 0
  try {
    while (total < limit) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      total += value.length
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).subarray(0, limit)
}

/**
 * Fetch one candidate and return a fingerprint of its bytes, or null if it is
 * not a live document. b4sport serves .odt as application/octet-stream and
 * other hosts serve PDFs under half a dozen types, so we do not require a
 * particular one — we only refuse text/html, which is what a soft 404 or a
 * login redirect answers with.
 */
async function documentFingerprint(url, opts) {
  return fetchWithin(url, opts, async (res, contentType) => {
    if (contentType.includes('text/html')) return null
    const bytes = await readCapped(res, opts.maxDocBytes)
    if (bytes.length === 0) return null
    return createHash('sha1').update(bytes).digest('hex')
  })
}

/**
 * Find the regulamin linked from a scraper_all-shaped row's own registration
 * page. Returns a fetch-verified URL, or null when the page links none, links
 * none this row can claim, links more than one distinct document, or will not
 * load.
 *
 * @param {object} row  needs registration_url, and name/location to claim a link
 * @param {object} [deps]
 * @param {Function} [deps.fetchImpl]
 * @param {number}   [deps.timeoutMs]
 * @param {number}   [deps.maxCandidates]  above this the page is a document
 *                                         index, not an event page
 * @param {number}   [deps.maxDocBytes]
 */
export async function resolveRegistrationPageRegulamin(row, deps = {}) {
  const {
    fetchImpl = fetch,
    timeoutMs = 10000,
    maxCandidates = 6,
    maxDocBytes = MAX_DOC_BYTES,
  } = deps
  const opts = { fetchImpl, timeoutMs, maxDocBytes }
  const pageUrl = row?.registration_url
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) return null

  const html = await fetchWithin(pageUrl, opts, (res, contentType) =>
    contentType.includes('text/html') ? res.text() : null)
  if (!html) return null

  const candidates = collectRegulaminDocLinks(html, pageUrl)
  if (candidates.length === 0 || candidates.length > maxCandidates) return null

  const mine = attributableCandidates(candidates, row)
  if (mine.length === 0) return null

  let fingerprint = null
  for (const c of mine) {
    const seen = await documentFingerprint(c.url, opts)
    if (!seen) return null
    if (fingerprint === null) fingerprint = seen
    else if (seen !== fingerprint) return null
  }

  return mine[0].url
}
