// Fetch a regulamin and read its text: PDF, DOCX, an HTML page, or a public
// Google Drive folder or file. Host-only: `pdftotext` and macOS `textutil` do
// the reading, and neither is in the backend Docker image.
//
// Shared by run-enrich-from-regulamin.js, which mines the document, and
// verify-regulamin-urls.js, which checks that regulamin_url still points at one.

import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { looksLikeRegulamin } from '../../src/lib/looksLikeRegulamin.js'
import { resolveRegulaminFromPageHtml } from './registration-page-regulamin.js'

export const FETCH_HEADERS = { 'User-Agent': 'leszy.run/1.0 (lukasz@leszy.run)' }

export function tmpPath(ext) {
  return join(tmpdir(), `regulamin-${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`)
}

export async function fetchBuffer(url) {
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    const buffer = Buffer.from(await res.arrayBuffer())
    return { buffer, contentType }
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
  const f = tmpPath(kind === 'pdf' ? 'pdf' : kind === 'docx' ? 'docx' : 'html')
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
  return { kind, text, html: kind === 'html' ? dl.buffer.toString('utf-8') : undefined }
}
