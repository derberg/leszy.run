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
//   - it must also state the race's date (13.12.2026, 13 grudnia 2026). An
//     older edition's regulamin passes every other test, and so does another
//     race of the same organizer: the race page above links six editions, and
//     b4sport's ultra_swir page offers its summer race's rules to the autumn
//     and spring ones;
//   - the first document that passes is the answer. Links are taken best
//     first: labelled regulamin, then naming this year, then nearer.
//
// Nothing found returns null, and the caller clears the field. An empty
// regulamin_url costs the fields it would have filled; a wrong one costs the
// same fields and fills them with another document's values.

import * as cheerio from 'cheerio'
import { scoreRegulaminCandidate } from '../../src/lib/pickRegulaminUrl.js'
import { looksLikeRegulamin, eventNameHits } from '../../src/lib/looksLikeRegulamin.js'
import { htmlToText } from './regulaminDocument.js'

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
 * @returns {Array<{url: string, rank: number, labelled: boolean, years: string[]}>}
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
    // scoreRegulaminCandidate also takes "statut", which on an organizer's
    // site is the association's own statute: kondycja.com.pl/o-nas/statut/
    // was offered for 13. Cross Mikołajkowy. Only a regulamin is followed as one.
    const saysRegulamin = /regulamin|regulations?\b|\brules\b/i.test(`${text} ${decoded}`)
    const name = eventNameHits(`${text} ${decoded.replace(/[-_/.]+/g, ' ')}`, eventName)
    const named = name.of > 0 && name.hits >= Math.min(2, name.of)

    let rank
    if (score >= 1 && saysRegulamin) rank = score + (named ? 1 : 0)
    else if (named && host === pageHost) rank = 0.5
    else return
    seen.add(url)
    out.push({ url, rank, labelled: score >= 1 && saysRegulamin, years: linkYears(url, text) })
  })
  return out.sort((a, b) => b.rank - a.rank).slice(0, PER_PAGE)
}

// One page under its http and https, www and bare, slash and no-slash
// spellings: a WordPress menu links all of them, and each costs a fetch.
function pageKey(url) {
  return String(url).replace(/#.*$/, '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '').toLowerCase()
}

// The years a link states in its own words: the label and the file or page
// name, never an upload folder (/uploads/2025/10/ is when a file was put up,
// and a January race's rules go up the year before).
function linkYears(url, label) {
  let last = ''
  try { last = decodeURIComponent(new URL(url).pathname.replace(/\/+$/, '').split('/').pop() || '') } catch { /* none */ }
  return [...new Set(`${label} ${last}`.match(/20\d{2}/g) || [])]
}

// What a page says it is: its <title> and its first headings. A labelled link
// can still land on an ordinary page, and an ordinary page's text carries the
// site's sidebar: kondycja.com.pl's "Regulamin" menu led to another race's
// page, whose news column stated 13. Cross Mikołajkowy's date.
function pageTitledRegulamin(html) {
  const $ = cheerio.load(html || '')
  const heads = [$('title').first().text(), ...$('h1, h2').slice(0, 3).map((_, h) => $(h).text()).get()]
  return heads.some((h) => /regulamin|regulations?\b|\brules\b/i.test(h))
}

/**
 * @param {object}   args
 * @param {object}   args.row         needs name and date; regulamin_url,
 *                                    registration_url and website are the start
 * @param {Function} args.fetchDoc    url => Promise<{kind: 'pdf'|'docx'|'html', text: string, html?: string, finalUrl?: string} | {error}>
 * @param {string[]} [args.skip]      urls already judged not to be the regulamin
 * @param {number}   [args.maxFetches]
 * @param {number}   [args.maxDepth]
 * @returns {Promise<{url: string, via: string, sections: number, statesDate: boolean} | null>}
 */
export async function huntRegulamin({ row, fetchDoc, skip = [], maxFetches = 25, maxDepth = 2 }) {
  const year = String(row?.date || '').slice(0, 4)
  const starts = [...new Set([row?.regulamin_url, row?.registration_url, row?.website].filter(Boolean))]
  const rejected = new Set(skip.map(pageKey))
  const visited = new Set()
  // Best first, not breadth first. A race site's menu links every past
  // edition's regulamin, and walked in page order they spend the budget before
  // this year's: bieglovelas.pl links eight, and the 2026 one sits on the race
  // page one click further. A link naming this race's year goes first, one
  // naming only another year last.
  let order = 0
  const queue = starts.map((url) => ({ url, depth: 0, via: url, labelled: false, priority: 100, order: order++ }))
  let fetches = 0

  while (queue.length > 0 && fetches < maxFetches) {
    queue.sort((a, b) => (b.priority - a.priority) || (a.order - b.order))
    const { url, depth, via, labelled } = queue.shift()
    if (visited.has(pageKey(url))) continue
    visited.add(pageKey(url))
    fetches++
    const doc = await fetchDoc(url)
    if (!doc || doc.error) continue
    if (doc.finalUrl) visited.add(pageKey(doc.finalUrl))

    // A page is taken as the regulamin only when a link called it one and the
    // page calls itself one. A page reached because its label names the race
    // is the race's page, and the race's page states the date, the distances
    // and the organizer: e-gepard's show-race page scores five sections and is
    // the sign-up form.
    const isPage = doc.kind === 'html'
    if (depth > 0 && !rejected.has(pageKey(url)) && (!isPage || (labelled && pageTitledRegulamin(doc.html)))) {
      // A page's text is the whole site around it, so a page must pass on its
      // structure alone; the allowance for a short document that names the
      // race is for documents.
      const judged = looksLikeRegulamin(doc.text, isPage ? {} : { eventName: row?.name })
      // It has to state the race's date. A regulamin naming the race and the
      // year can still be another race of the same organizer: both Ultra Świr
      // rows (autumn 2026, spring 2027) were offered the summer Wyspowy Ultra
      // Świr 2027 regulamin, which names "ultra świr", 2026 and 2027. And a
      // platform's terms of service names no race and no date.
      // On a page the date must be in the content, not in the sidebar's list
      // of coming races.
      const dateText = isPage ? htmlToText(doc.html, { contentOnly: true }) : doc.text
      if (judged.verdict === 'regulamin' && statesDate(dateText, row?.date)) {
        return { url, via, sections: judged.sections, statesDate: true }
      }
    }

    if (isPage && doc.html && depth < maxDepth) {
      for (const link of regulaminLinks(doc.html, doc.finalUrl || url, row?.name)) {
        if (visited.has(pageKey(link.url))) continue
        const years = link.years || []
        const yearBonus = !year || years.length === 0 ? 0 : years.includes(year) ? 2 : -3
        queue.push({
          url: link.url, depth: depth + 1, via: url, labelled: link.labelled,
          priority: link.rank + yearBonus - depth, order: order++,
        })
      }
    }
  }
  return null
}
