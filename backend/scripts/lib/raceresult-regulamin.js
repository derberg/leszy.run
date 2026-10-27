// Deterministic regulamin discovery for races that register on my.raceresult.com.
//
// WHY THIS EXISTS
// A raceresult event page lists its documents as menu tabs, and an organizer
// can add a tab that shows an external document. The tab's content is never in
// the HTML: the page loads it with JavaScript from
//   https://my.raceresult.com/<id>/<key>/config
// which answers {"Data": "<document url>", "Subtype": "", ...}. So the search
// step, which only reads HTML, never sees it.
//
// ZIMOWY ULTRA TURNICKI (2027-01-16, biegigorskie) is the case that showed it.
// Its registration_url is https://my.raceresult.com/412049/registration. On
// 2026-10-27 the search found only the 2022 edition's PDF on the organizer
// site and rightly rejected it, so the row published with no regulamin, no
// price and no deadline. The "Regulamin" tab of the same raceresult event
// (/412049/extcontent) loads http://s-time.pl/regulamin/2027/zut_regulamin.pdf,
// the 2027 rules, verified that day: 200 application/pdf after a 301 to https,
// and the text reads "odbędzie się 16 stycznia 2027".
//
// GUARDS
//   1. The tab's own label must say it is the rules (regulamin / statut). An
//      organizer can attach anything to an external-content tab: a course map,
//      a video, a results page.
//   2. A raceresult event id is one edition, but the document it points at can
//      still be last year's file. A four-digit year in the document URL that is
//      not the race's year rejects it. No year in the URL says nothing.
//   3. verifyPdf: the document must be a live PDF, after following redirects.
// Any guard failing returns null and leaves the field to the web search.

import { verifyPdf } from '../../src/lib/verifyPdf.js'

const UA = 'leszy.run/1.0 (kontakt@leszy.run)'
const BASE = 'https://my.raceresult.com'
const RULES_LABEL = /regulamin|statut/i

/**
 * The raceresult event id from the row's registration_url or website.
 * @returns {string|null}
 */
export function raceresultEventId(row) {
  for (const url of [row.registration_url, row.website]) {
    const m = (url || '').match(/^https?:\/\/(?:my\.)?raceresult\.com\/(\d+)(?:[/?#]|$)/i)
    if (m) return m[1]
  }
  return null
}

/**
 * Menu tabs of an event page whose label names the rules, as content keys
 * ("extcontent"). The menu markup is `<a href="/<id>/<key>">Label</a>`.
 * @returns {string[]}
 */
export function rulesTabKeys(html, id) {
  const keys = []
  const re = new RegExp(`<a[^>]+href=["']/${id}/([A-Za-z0-9_-]+)["'][^>]*>([^<]*)</a>`, 'g')
  for (const [, key, label] of html.matchAll(re)) {
    if (RULES_LABEL.test(label) && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/** True when the URL names a year that is not the race's. */
export function namesOtherYear(url, date) {
  const raceYear = String(date || '').slice(0, 4)
  if (!/^\d{4}$/.test(raceYear)) return false
  const years = (url.match(/(?<!\d)20\d{2}(?!\d)/g) || [])
  return years.length > 0 && !years.includes(raceYear)
}

async function get(url, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA } })
    return res.ok ? res : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The verified regulamin PDF behind the event's rules tab, or null.
 */
export async function resolveRaceresultRegulamin(row, { timeoutMs = 10000 } = {}) {
  const id = raceresultEventId(row)
  if (!id) return null

  const page = await get(`${BASE}/${id}/`, timeoutMs)
  if (!page) return null
  const keys = rulesTabKeys(await page.text(), id)

  const found = new Set()
  for (const key of keys) {
    const res = await get(`${BASE}/${id}/${key}/config?lang=pl`, timeoutMs)
    if (!res) continue
    let cfg
    try { cfg = await res.json() } catch { continue }
    const url = typeof cfg?.Data === 'string' ? cfg.Data.trim() : ''
    if (cfg?.Subtype === 'youtube' || !/^https?:\/\//i.test(url)) continue
    if (namesOtherYear(url, row.date)) continue
    if (await verifyPdf(url, { timeoutMs })) found.add(url)
  }
  // Two rules tabs pointing at two different documents is a choice we
  // cannot make for the organizer.
  return found.size === 1 ? [...found][0] : null
}
