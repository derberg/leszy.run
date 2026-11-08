// Fetch a regulamin and read its text: PDF, DOCX, an HTML page, or a public
// Google Drive folder or file. Host-only: `pdftotext` and macOS `textutil` do
// the reading, and neither is in the backend Docker image.
//
// Shared by run-enrich-from-regulamin.js, which mines the document, and
// verify-regulamin-urls.js, which checks that regulamin_url still points at one.

import { execSync } from 'child_process'
import * as cheerio from 'cheerio'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { looksLikeRegulamin } from '../../src/lib/looksLikeRegulamin.js'
import { resolveRegulaminFromPageHtml } from './registration-page-regulamin.js'

export const FETCH_HEADERS = { 'User-Agent': 'leszy.run/1.0 (lukasz@leszy.run)' }

export function tmpPath(ext) {
  return join(tmpdir(), `regulamin-${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`)
}

// A my.raceresult.com event is a JavaScript page: each menu tab loads its
// content from /<id>/<key>/config, which answers {"InfoText": "<html>"} for a
// page the organizer typed in, or {"Data": "<url>"} for a document. The tab's
// own HTML holds only the menu, so read as a page it scores 1 section, and the
// Koliba Łomnicka and Waligóra Run Cross regulamins (2026-11-08) were judged
// not to be regulamins while their config said „Regulamin biegu … 2027”.
// See raceresult-regulamin.js for the tabs found from a registration page.
const RACERESULT_TAB = /^https?:\/\/my\.raceresult\.com\/(\d+)\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i
const RACERESULT_NOT_CONTENT = /^(registration|rejestracja|participants|results|wyniki|lista|startlist|config|live)$/i

export function raceresultConfigUrl(url) {
  const m = RACERESULT_TAB.exec(String(url || ''))
  if (!m || RACERESULT_NOT_CONTENT.test(m[2])) return null
  return `https://my.raceresult.com/${m[1]}/${m[2]}/config`
}

export async function fetchBuffer(url, { followConfig = true } = {}) {
  const configUrl = followConfig ? raceresultConfigUrl(url) : null
  if (configUrl) {
    const cfg = await fetchBuffer(configUrl, { followConfig: false })
    if (!cfg.error) {
      let json = null
      try { json = JSON.parse(cfg.buffer.toString('utf-8')) } catch { /* not a config */ }
      if (json && typeof json.InfoText === 'string' && json.InfoText.trim()) {
        const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${json.InfoText}</body></html>`
        return { buffer: Buffer.from(html, 'utf-8'), contentType: 'text/html', finalUrl: url }
      }
      if (json && typeof json.Data === 'string' && /^https?:\/\//i.test(json.Data)) {
        return fetchBuffer(json.Data, { followConfig: false })
      }
    }
  }
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    const buffer = Buffer.from(await res.arrayBuffer())
    // Where the redirects ended. A page's relative links resolve against it:
    // runvegan.pl/niedzwiedzibieg/ is niedzwiedzibieg.pl, and its "regulamin.html"
    // read against the old address is a redirect to the home page.
    return { buffer, contentType, finalUrl: res.url || url }
  } catch (err) {
    return { error: err.message?.slice(0, 100) || 'unknown' }
  }
}

// Identify what we downloaded from magic bytes first, then content-type / URL hints.
// Returns 'pdf' | 'docx' | 'html' | 'unknown'.
export function detectKind(buffer, contentType, url) {
  const ascii = buffer.slice(0, 8).toString('latin1')
  if (ascii.startsWith('%PDF')) return 'pdf'
  if (ascii.startsWith('PK')) {
    // Office Open XML (.docx) is a zip — confirm via name, content-type, or a `word/` entry
    if (/\.docx(\?|$)/i.test(url) || contentType.includes('wordprocessingml')) return 'docx'
    if (buffer.toString('latin1', 0, Math.min(buffer.length, 4000)).includes('word/')) return 'docx'
    return 'unknown'
  }
  if (contentType.includes('pdf') || /\.pdf(\?|$)/i.test(url)) return 'pdf'
  if (contentType.includes('wordprocessingml') || /\.docx(\?|$)/i.test(url)) return 'docx'
  const head = buffer.slice(0, 200).toString('utf-8').trim().toLowerCase()
  if (contentType.includes('html') || head.startsWith('<!doctype') || head.startsWith('<html')) return 'html'
  return 'unknown'
}

// Extract plain text from a downloaded buffer with the right local tool:
// pdf -> pdftotext, docx/html -> textutil (macOS). Returns text or null.
export function extractText(buffer, kind) {
  if (kind === 'html') return htmlToText(decodeHtml(buffer))
  const f = tmpPath(kind === 'pdf' ? 'pdf' : 'docx')
  try {
    writeFileSync(f, buffer)
    const cmd = kind === 'pdf'
      ? `pdftotext -enc UTF-8 "${f}" -`
      : `textutil -convert txt -stdout "${f}"`
    return execSync(cmd, { encoding: 'utf-8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
  } catch {
    return null
  } finally {
    try { unlinkSync(f) } catch {}
  }
}

// The page's own charset, from its <meta>: plus-timing and older Polish sites
// still serve ISO-8859-2.
export function decodeHtml(buffer) {
  const head = buffer.subarray(0, 4096).toString('latin1')
  const m = /charset\s*=\s*["']?([A-Za-z0-9_-]+)/i.exec(head)
  const label = m ? m[1].toLowerCase() : 'utf-8'
  try { return new TextDecoder(label).decode(buffer) } catch { return buffer.toString('utf-8') }
}

// The visible text of a page, a line per block. textutil used to do this and
// silently dropped most of some pages: kondycja.com.pl's Cross Mikołajkowy page
// holds the whole regulamin (CEL IMPREZY, ORGANIZATORZY, ZGŁOSZENIA…) and came
// back as 838 characters of menu, scoring 1 section (2026-11-08).
const BLOCK = 'p,div,section,article,header,footer,li,ul,ol,tr,table,h1,h2,h3,h4,h5,h6,br,dt,dd,blockquote,pre,nav,aside,main'
//
// { contentOnly: true } also drops the site's furniture: menus, sidebars,
// widgets, header and footer. On a club site the sidebar lists the coming
// races with their dates, so another race's page "states" this race's date
// there (kondycja.com.pl's II Memoriał page and 13. Cross Mikołajkowy).
const FURNITURE = 'nav,aside,header,footer,[class*=sidebar],[id*=sidebar],[class*=widget],[class*=menu],[id*=menu]'
export function htmlToText(html, { contentOnly = false } = {}) {
  const $ = cheerio.load(html || '')
  $('script,style,noscript,svg,template,iframe').remove()
  if (contentOnly) $(FURNITURE).remove()
  $(BLOCK).each((_, el) => { $(el).prepend('\n').append('\n') })
  $('td,th').each((_, el) => { $(el).append(' ') })
  return $('body').text().replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
}

const driveFolderId = (url) => (url.match(/\/drive\/folders\/([0-9A-Za-z_-]+)/) || [])[1] || null
const driveFileId = (url) =>
  (url.match(/\/file\/d\/([0-9A-Za-z_-]+)/) || [])[1] ||
  (url.match(/[?&]id=([0-9A-Za-z_-]+)/) || [])[1] || null
const driveDownloadUrl = (id) => `https://drive.google.com/uc?export=download&id=${id}`

// Parse a public Drive folder page for the file ids it lists (rendered as data-id="...").
async function listDriveFolder(url) {
  const res = await fetchBuffer(url)
  if (res.error) return res
  const html = res.buffer.toString('utf-8')
  const ids = [...new Set([...html.matchAll(/data-id="(1[0-9A-Za-z_-]{25,44})"/g)].map((m) => m[1]))]
  if (ids.length === 0) return { error: 'no files in folder (private or empty?)' }
  return { ids }
}

// Download a regulamin from any supported URL and return a local file ready for Claude:
// { path, kind } where kind 'pdf' is read natively by Claude (best table fidelity) and
// 'text' is a .txt we extracted ourselves (docx, html page, or multi-file Drive folder).
export async function acquireRegulamin(url, row, { followWrapper = true } = {}) {
  // 1) Google Drive folder -> download every file, extract text, concatenate
  const folderId = driveFolderId(url)
  if (folderId) {
    const folder = await listDriveFolder(url)
    if (folder.error) return folder
    const chunks = []
    for (const id of folder.ids) {
      const dl = await fetchBuffer(driveDownloadUrl(id))
      if (dl.error) continue
      const kind = detectKind(dl.buffer, dl.contentType, '')
      if (kind !== 'pdf' && kind !== 'docx') continue // skip images / unknown / interstitials
      const text = extractText(dl.buffer, kind)
      if (text && text.trim().length > 50) chunks.push(`=== ${id} (${kind}) ===\n${text.trim()}`)
    }
    if (chunks.length === 0) return { error: 'Drive folder had no extractable documents' }
    const f = tmpPath('txt')
    const joined = chunks.join('\n\n')
    writeFileSync(f, joined, 'utf-8')
    return { path: f, kind: 'text', text: joined, identity: looksLikeRegulamin(joined, { eventName: row?.name }) }
  }

  // 2) Single file (Drive file link gets rewritten to its direct-download URL)
  const fileId = driveFileId(url)
  const dl = await fetchBuffer(fileId ? driveDownloadUrl(fileId) : url)
  if (dl.error) return dl
  if (dl.buffer.length < 500) return { error: `too small (${dl.buffer.length} bytes)` }

  const kind = detectKind(dl.buffer, dl.contentType, url)
  // A Drive file that comes back as HTML is the virus-scan interstitial, not a document
  if (fileId && kind === 'html') return { error: 'Drive interstitial (not a direct document)' }
  if (kind === 'unknown') return { error: `unsupported type (${dl.contentType || 'no content-type'})` }

  if (kind === 'pdf') {
    const f = tmpPath('pdf')
    writeFileSync(f, dl.buffer)
    // Claude reads the PDF natively, so we do NOT need the text for enrichment —
    // but we do need it to check the document is this race's regulamin at all.
    // A consent form or a national park's visitor rules is a live PDF with a
    // plausible filename; only the text says otherwise.
    const pdfText = extractText(dl.buffer, 'pdf') || ''
    return { path: f, kind: 'pdf', text: pdfText, identity: looksLikeRegulamin(pdfText, { eventName: row?.name }) }
  }

  const text = extractText(dl.buffer, kind)
  if (!text || text.trim().length < 50) return { error: `${kind} extraction empty` }
  const identity = looksLikeRegulamin(text, { eventName: row?.name })

  // An HTML page that does not read as a regulamin may still BE where the
  // regulamin lives. A WordPress site publishes rules written in Word by
  // uploading the file and giving it a page with a heading and a link. The
  // page is a wrapper, and everything the model is asked for is in the document
  // beside it. ZPGS 2027 (b4sport:13127) published with price_from, price_to
  // and registration_deadline null off a regulamin_url returning HTTP 200,
  // while ZPGS27_regulamin.docx.pdf one link away states the 230/255/280 zł
  // tiers and the 14.01.2027 payment deadline. Measured 2026-09-29: 7 of the
  // 195 future rows whose regulamin_url is an HTML page are this shape.
  //
  // Only one hop, and only when the page failed the structural test. A page
  // that reads as a regulamin IS the regulamin, whatever else it links.
  if (kind === 'html' && followWrapper && identity.verdict !== 'regulamin') {
    const wrapped = await resolveRegulaminFromPageHtml(dl.buffer.toString('utf-8'), url, row)
    if (wrapped && wrapped !== url) {
      const doc = await acquireRegulamin(wrapped, row, { followWrapper: false })
      if (!doc.error) return { ...doc, wrapperUrl: url, resolvedUrl: wrapped }
    }
  }

  const f = tmpPath('txt')
  writeFileSync(f, text.trim(), 'utf-8')
  // The page's markup goes back too: when the page is not the regulamin, its
  // links are where huntRegulamin() looks for the one that is.
  const html = kind === 'html' ? dl.buffer.toString('utf-8') : undefined
  return { path: f, kind: 'text', text, identity, html, pageUrl: url }
}

/**
 * Fetch one URL and read it, for huntRegulamin(). No Drive handling and no
 * wrapper hop: the hunt does its own walking.
 *
 * @returns {Promise<{kind: 'pdf'|'docx'|'html', text: string, html?: string} | {error: string}>}
 */
export async function fetchDoc(url) {
  const dl = await fetchBuffer(url)
  if (dl.error) return dl
  const kind = detectKind(dl.buffer, dl.contentType, url)
  if (kind === 'unknown') return { error: `unsupported type (${dl.contentType || 'no content-type'})` }
  const text = extractText(dl.buffer, kind) || ''
  return { kind, text, html: kind === 'html' ? dl.buffer.toString('utf-8') : undefined, finalUrl: dl.finalUrl || url }
}
