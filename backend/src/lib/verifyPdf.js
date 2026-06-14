// Shared regulamin/PDF liveness check — used before writing any regulamin URL
// to a scraper table.
//
// Project rule (CLAUDE.md → "URL verification — REQUIRED before writing any URL
// to the DB"): a 200 is NOT proof a URL is good. We HEAD the URL (following the
// full redirect chain) and require a real PDF content-type, so a soft-404, a
// login redirect, or a generic HTML error page is never written as a regulamin.
// If verification fails for any reason (network, timeout, wrong type), we return
// false — the caller must drop the candidate, not write it.

const UA = 'leszy.run/1.0 (kontakt@leszy.run)'

/**
 * @param {string} url
 * @returns {Promise<boolean>} true only on a live document whose content-type is a PDF
 */
export async function verifyPdf(url, { timeoutMs = 10000 } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return false
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA },
    })
    // Some servers reject HEAD — fall back to a tiny ranged GET.
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
      })
    }
    if (!res.ok && res.status !== 206) return false
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    return ct.includes('pdf')
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
