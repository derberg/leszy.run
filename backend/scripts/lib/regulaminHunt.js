// When regulamin_url turns out not to be the regulamin, look for the one that is.
//
// WHY
// A rejected regulamin_url is usually close to the real one. The page it points
// at is a site's "Regulaminy" menu, a race page that links "LINK DO
// REGULAMINU", or an organizer's home page. gpclubianka.pl/regulamin/ (XXVIII
// Bieg Niepodległości, 2026-11-08) is all of those at once: it links the Grand
// Prix cycle's regulamin, a dead PDF, and the race's own page, which links the
// 2026 regulamin beside every older edition's. Nulling the field there throws
// the answer away one click short of it.
//
// HOW
// Breadth first from the pages we already know for the row (regulamin_url,
// registration_url, website), two clicks deep, at most `maxFetches` requests:
//
//   - a link is followed when its address or label says regulamin (and not
//     oświadczenie, mapa, klauzula: scoreRegulaminCandidate), or when its label
//     names this race and it stays on the same site;
//   - every document reached is read and must pass looksLikeRegulamin() for
//     this race's name;
//   - it must also carry the race's year. An older edition's regulamin passes
//     every other test, and the race page above links six of them;
//   - of what is left, the document stating the race's date wins, then the one
//     naming more of the race's name, then the nearest.
//
// Nothing found returns null, and the caller clears the field. An empty
// regulamin_url costs the fields it would have filled; a wrong one costs the
// same fields and fills them with another document's values.

import * as cheerio from 'cheerio'
import { scoreRegulaminCandidate } from '../../src/lib/pickRegulaminUrl.js'
import { looksLikeRegulamin, eventNameHits } from '../../src/lib/looksLikeRegulamin.js'

const MONTHS = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca',
  'sierpnia', 'wrzesnia', 'pazdziernika', 'listopada', 'grudnia']

// Hosts whose pages never hold an organizer's regulamin, only links out.
const SKIP_HOST = /(^|\.)(facebook|fb|instagram|youtube|youtu|twitter|x|tiktok|google|goo|maps\.app\.goo|linkedin|strava)\.(com|pl|gl|be)$/i

const PER_PAGE = 12
const MAX_LABEL = 100

function fold(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (ch) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[ch] || ch))
}

/** Does the text state this date: 13.12.2026, 13 grudnia 2026, 2026-12-13? */
export function statesDate(text, isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''))
  if (!m) return false
  const [, y, mo, d] = m
  const day = String(Number(d))
  const t = fold(text).replace(/\s+/g, ' ')
  const numeric = new RegExp(`(^|[^0-9])0?${day}[./-]\\s?${mo}[./-]\\s?${y}`)
  const named = new RegExp(`(^|[^0-9])0?${day}\\s*${MONTHS[Number(mo) - 1]}\\s*${y}`)
  return numeric.test(t) || named.test(t) || t.includes(`${y}-${mo}-${d}`)
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' }
}

/**
 * The links on a page worth following, best first.
 * @returns {Array<{url: string, rank: number, labelled: boolean}>}
 */
export function regulaminLinks(html, baseUrl, eventName) {
  const $ = cheerio.load(html)
  const pageHost = hostOf(baseUrl)
  const seen = new Set([baseUrl.replace(/#.*$/, '')])
  const out = []
  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') || '').trim()
    if (!href || /^(mailto|tel|javascript):/i.test(href) || href.startsWith('#')) return
    let url
    try { url = new URL(href, baseUrl).toString().replace(/#.*$/, '') } catch { return }
    if (!/^https?:/i.test(url) || seen.has(url)) return
    const host = hostOf(url)
    if (SKIP_HOST.test(host)) return

    // A label is a few words. An anchor wrapping a news teaser carries a
    // paragraph, and a paragraph quoting "Regulaminu wyboru przedsięwzięć" is
    // not a link to a regulamin: kluki.pl's asbestos-grant teaser was followed
    // as one on 2026-11-08. Past that length only the address speaks.
    const fullText = $(a).text().replace(/\s+/g, ' ').trim()
    const text = fullText.length <= MAX_LABEL ? fullText : ''
    let decoded = url
    try { decoded = decodeURIComponent(url) } catch { /* keep it encoded */ }
    const score = scoreRegulaminCandidate({ href: url, text })
    if (score === null) return
    const name = eventNameHits(`${text} ${decoded.replace(/[-_/.]+/g, ' ')}`, eventName)
    const named = name.of > 0 && name.hits >= Math.min(2, name.of)

    let rank
    if (score >= 1) rank = score + (named ? 1 : 0)
    else if (named && host === pageHost) rank = 0.5
    else return
    seen.add(url)
    out.push({ url, rank, labelled: score >= 1 })
  })
  return out.sort((a, b) => b.rank - a.rank).slice(0, PER_PAGE)
}

/**
 * @param {object}   args
 * @param {object}   args.row         needs name and date; regulamin_url,
 *                                    registration_url and website are the start
 * @param {Function} args.fetchDoc    url => Promise<{kind: 'pdf'|'docx'|'html', text: string, html?: string} | {error}>
 * @param {string[]} [args.skip]      urls already judged not to be the regulamin
 * @param {number}   [args.maxFetches]
 * @param {number}   [args.maxDepth]
 * @returns {Promise<{url: string, via: string, sections: number, statesDate: boolean} | null>}
 */
export async function huntRegulamin({ row, fetchDoc, skip = [], maxFetches = 20, maxDepth = 2 }) {
  const year = String(row?.date || '').slice(0, 4)
  const starts = [...new Set([row?.regulamin_url, row?.registration_url, row?.website].filter(Boolean))]
  const rejected = new Set(skip)
  const visited = new Set()
  const queue = starts.map((url) => ({ url, depth: 0, via: url, labelled: false }))
  const found = []
  let fetches = 0

  while (queue.length > 0 && fetches < maxFetches) {
    const { url, depth, via, labelled } = queue.shift()
    if (visited.has(url)) continue
    visited.add(url)
    fetches++
    const doc = await fetchDoc(url)
    if (!doc || doc.error) continue

    // A page is taken as the regulamin only when a link called it one. A page
    // reached because its label names the race is the race's page, and the
    // race's page states the date, the distances and the organizer: e-gepard's
    // show-race page scores five sections and is the sign-up form.
    if (depth > 0 && !rejected.has(url) && (doc.kind !== 'html' || labelled)) {
      // A page's text is the whole site around it: the menu, the sidebar's
      // news, which on a council site names the race and its date. So a page
      // must pass as a regulamin on its structure alone; the allowance for a
      // short document that names the race is for documents.
      const judged = looksLikeRegulamin(doc.text, doc.kind === 'html' ? {} : { eventName: row?.name })
      const dated = statesDate(doc.text, row?.date)
      const nameHits = eventNameHits(doc.text, row?.name).hits
      // A platform's own terms of service is a regulamin with every section
      // and no race in it. The document has to name the race or its date.
      if (judged.verdict === 'regulamin' && (!year || doc.text.includes(year)) && (dated || nameHits > 0)) {
        found.push({ url, via, depth, sections: judged.sections, statesDate: dated, nameHits })
        // A page that is the regulamin is the answer from this branch; what it
        // links is something else (an annex, the results).
        continue
      }
    }

    if (doc.kind === 'html' && doc.html && depth < maxDepth) {
      for (const link of regulaminLinks(doc.html, url, row?.name)) {
        if (!visited.has(link.url)) queue.push({ url: link.url, depth: depth + 1, via: url, labelled: link.labelled })
      }
    }
  }

  if (found.length === 0) return null
  found.sort((a, b) =>
    (b.statesDate - a.statesDate) || (b.nameHits - a.nameHits) || (a.depth - b.depth))
  const best = found[0]
  return { url: best.url, via: best.via, sections: best.sections, statesDate: best.statesDate }
}
