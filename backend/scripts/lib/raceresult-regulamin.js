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
// GUARDS. The URL is free text the organizer typed into raceresult, unlike a
// dostartu statute, which is derived from the event id. So:
//   1. The tab's own label must say it is THIS race's rules: regulamin or
//      statut, and not a series, classification or privacy document
//      ("Regulamin cyklu", "Regulamin Grand Prix", "Regulamin RODO").
//   2. A year in the document's FILE NAME that is not the race's rejects it.
//      Only the file name: an upload folder such as /uploads/2026/11/ holds the
//      upload date, and a January race's rules are uploaded the year before.
//   3. verifyPdf: the document must be a live PDF, after following redirects.
//   4. The document's text must name the race's DATE ("16 stycznia 2027" or
//      "16.01.2027"). A 2027 raceresult event copied from the 2026 one can keep
//      a tab pointing at a stable URL that still holds last year's rules, and
//      nothing in the URL shows it. The year alone is not enough: last year's
//      rules can mention it ("dane przechowywane do 31.12.2027"). A PDF whose
//      text cannot be read (a scan, no pdftotext), or a row with no date, fails.
// Any guard failing returns null and leaves the field to the web search.

import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { verifyPdf } from '../../src/lib/verifyPdf.js'

const UA = 'leszy.run/1.0 (kontakt@leszy.run)'
const BASE = 'https://my.raceresult.com'
const RULES_LABEL = /regulamin|statut/i
const NOT_THIS_RACE = /\bcykl|grand\s*prix|\bgp\b|klasyfikac|\bligi\b|\bliga\b|\brodo\b|prywatn|ochrony danych/i
const MAX_PDF_BYTES = 20 * 1024 * 1024
const MONTHS = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia']

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
    if (RULES_LABEL.test(label) && !NOT_THIS_RACE.test(label) && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/** True when the document's file name names a year that is not the race's. */
export function namesOtherYear(url, date) {
  const raceYear = String(date || '').slice(0, 4)
  if (!/^\d{4}$/.test(raceYear)) return false
  let file = url
  try { file = new URL(url).pathname } catch {}
  file = file.split('/').pop() || ''
  try { file = decodeURIComponent(file) } catch {}
  const years = (file.match(/(?<!\d)20\d{2}(?!\d)/g) || [])
  return years.some((y) => y !== raceYear)
}

/** True when the text names the race's date, in words or in digits. */
export function namesRaceDate(text, date) {
  const m = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return false
  const [, y, mm, dd] = m
  const d = String(Number(dd))
  const t = String(text || '').replace(/\s+/g, ' ').toLowerCase()
  const words = new RegExp(`(?<!\\d)0?${d} ${MONTHS[Number(mm) - 1]} ${y}`)
  const digits = new RegExp(`(?<!\\d)0?${d}[./-]${mm}[./-]${y}`)
  return words.test(t) || digits.test(t)
}

/** The PDF's text through pdftotext, or '' when it cannot be read. */
export async function pdfText(url, { timeoutMs = 10000 } = {}) {
  // One deadline for headers AND body, so a server trickling the body cannot
  // hang the step.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let dir = null
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA } })
    if (!res.ok) return ''
    if (Number(res.headers.get('content-length') || 0) > MAX_PDF_BYTES) return ''
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length > MAX_PDF_BYTES) return ''
    dir = await mkdtemp(join(tmpdir(), 'raceresult-'))
    const file = join(dir, 'r.pdf')
    await writeFile(file, body)
    const { stdout } = await promisify(execFile)('pdftotext', [file, '-'], { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 })
    return stdout
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
    if (dir) await rm(dir, { recursive: true, force: true })
  }
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
export async function resolveRaceresultRegulamin(row, { timeoutMs = 10000, extractText = pdfText } = {}) {
  const id = raceresultEventId(row)
  // Without a date neither edition guard can run.
  if (!id || !/^\d{4}-\d{2}-\d{2}/.test(String(row.date || ''))) return null

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
    if (!(await verifyPdf(url, { timeoutMs }))) continue
    const text = await extractText(url, { timeoutMs })
    if (!namesRaceDate(text, row.date)) continue
    found.add(url)
  }
  // Two rules tabs pointing at two different documents is a choice we
  // cannot make for the organizer.
  return found.size === 1 ? [...found][0] : null
}
