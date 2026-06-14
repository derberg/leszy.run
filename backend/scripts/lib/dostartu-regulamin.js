// Deterministic + verified dostartu regulamin (rules PDF) resolver.
//
// dostartu hosts every event's statute at a fixed, predictable path:
//   https://dostartu.pl/statute_files/<competitionId>_pl.pdf
// where <competitionId> is the same id embedded in the registration permalink
// (dostartu.pl/permalink-v<id>). Because the URL is fully derivable from data we
// already have, there is NEVER a reason to pay for a web search to "find" it.
//
// BUT: the statute is sometimes published days after the event first appears, so
// the file may not exist yet. We therefore VERIFY (HTTP 200 + application/pdf,
// following redirects) before returning a URL — we never write a 404.

import { verifyPdf } from '../../src/lib/verifyPdf.js'

export { verifyPdf }

/**
 * Find the dostartu competition id for a scraper_all-shaped row, in priority
 * order: primary source, source_links, then the registration_url permalink.
 * Returns a string id or null.
 */
export function deriveDostartuId(row) {
  if (row.source === 'dostartu' && row.source_id) return String(row.source_id)
  const link = (row.source_links || []).find(l => l.source === 'dostartu')
  if (link?.source_id) return String(link.source_id)
  const m = (row.registration_url || '').match(/dostartu\.pl\/permalink-v(\d+)/i)
  if (m) return m[1]
  return null
}

/**
 * Derive the canonical dostartu statute URL for a row and verify the file is
 * actually there. Returns the verified URL, or null if the row isn't a dostartu
 * event or the statute hasn't been published yet.
 */
export async function resolveDostartuRegulamin(row) {
  const id = deriveDostartuId(row)
  if (!id) return null
  const url = `https://dostartu.pl/statute_files/${id}_pl.pdf`
  return (await verifyPdf(url)) ? url : null
}
