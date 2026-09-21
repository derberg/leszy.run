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
// A b4sport organizer page hosts several editions of a race side by side, so
// "this page links a Regulamin" is not "this page links THIS event's
// regulamin". We therefore only accept a candidate set that resolves to ONE
// document: every candidate is fetched and compared byte for byte. Three links
// to the same file is one document, which is exactly what ultra_swir publishes
// (all three .odt files share an md5). Two different files is a choice the
// markup cannot make for us, so we return null and leave it to the web search.
// A null regulamin costs one empty field; the wrong edition's regulamin costs
// every field the next enricher reads out of it.

import { createHash } from 'crypto'
import * as cheerio from 'cheerio'
import { scoreRegulaminCandidate } from '../../src/lib/pickRegulaminUrl.js'

const UA = 'leszy.run/1.0 (kontakt@leszy.run)'

// A regulamin may also be a plain HTML page, but on a registration page every
// link is an HTML page, so "it is a document" is what separates the rules file
// from the sign-up form and the results list.
const DOCUMENT = /\.(pdf|odt|docx?|rtf)($|[?#])/i

/**
 * Collect the document links on a page that declare themselves a regulamin,
 * in DOM order, absolute and deduplicated.
 *
 * The href alone is not enough: b4sport stores uploads under an opaque hash
 * (/users-folder/1104/files/63269af0….odt), so only the anchor text says what
 * the file is. scoreRegulaminCandidate applies the project rule — a link is
 * the regulamin only if it says so, and never an oświadczenie, a klauzula RODO
 * or a course map.
 *
 * @param {string} html
 * @param {string} baseUrl  resolve relative hrefs against this
 * @returns {string[]}
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
    out.push(url)
  })

  return out
}

async function get(url, { fetchImpl, timeoutMs }) {
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
    return { res, contentType }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch one candidate and return a fingerprint of its bytes, or null if it is
 * not a live document. b4sport serves .odt as application/octet-stream and
 * other hosts serve PDFs under half a dozen types, so we do not require a
 * particular one — we only refuse text/html, which is what a soft 404 or a
 * login redirect answers with.
 */
async function documentFingerprint(url, opts) {
  const hit = await get(url, opts)
  if (!hit) return null
  if (hit.contentType.includes('text/html')) return null
  try {
    const bytes = Buffer.from(await hit.res.arrayBuffer())
    if (bytes.length === 0) return null
    return createHash('sha1').update(bytes).digest('hex')
  } catch {
    return null
  }
}

/**
 * Find the regulamin linked from a scraper_all-shaped row's own registration
 * page. Returns a fetch-verified URL, or null when the page links none, links
 * more than one distinct document, or will not load.
 *
 * @param {object} row  needs registration_url
 * @param {object} [deps]
 * @param {Function} [deps.fetchImpl]
 * @param {number}   [deps.timeoutMs]
 * @param {number}   [deps.maxCandidates]  above this the page is a document
 *                                         index, not an event page
 */
export async function resolveRegistrationPageRegulamin(row, deps = {}) {
  const { fetchImpl = fetch, timeoutMs = 10000, maxCandidates = 6 } = deps
  const opts = { fetchImpl, timeoutMs }
  const pageUrl = row?.registration_url
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) return null

  const page = await get(pageUrl, opts)
  if (!page || !page.contentType.includes('text/html')) return null

  let html
  try { html = await page.res.text() } catch { return null }

  const candidates = collectRegulaminDocLinks(html, pageUrl)
  if (candidates.length === 0 || candidates.length > maxCandidates) return null

  let fingerprint = null
  for (const url of candidates) {
    const seen = await documentFingerprint(url, opts)
    if (!seen) return null
    if (fingerprint === null) fingerprint = seen
    else if (seen !== fingerprint) return null
  }

  return candidates[0]
}
