// The PZLA register of certified road courses ("rejestr tras atestowanych").
//
// http://www.taddziek.pl/rejestr_tras_atestowanych.html is kept by Tadeusz
// Dziekoński, the PZLA's administrator for course certification, and is the only
// national list there is (checked 2026-11-07: pzla.pl links no course register,
// and AIMS lists only a handful of large races). It is one static table in
// ISO-8859-2 with no paging and no detail pages: certified distance, town, race
// name, certification date, status. About 1,250 rows.
//
// Plain http on purpose: https on that host serves the hosting company's
// certificate (vipserv.org), so every TLS client refuses it.
//
// The register certifies a COURSE, not an edition: it has no event date and no
// URL. It can only ever say "this race's 10 km course was measured".

import * as cheerio from 'cheerio'

export const REGISTER_URL = 'http://www.taddziek.pl/rejestr_tras_atestowanych.html'

// A certificate is valid for five years (PZLA course certification rules). The
// register marks most expired rows by hand ("utracił ważność po 5 latach"), but
// not all of them, so the date is checked too.
export const VALIDITY_YEARS = 5

/** Fetches the register page and decodes it from ISO-8859-2. */
export async function fetchRegister(fetchImpl = fetch) {
  const res = await fetchImpl(REGISTER_URL, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`atest register: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return new TextDecoder('iso-8859-2').decode(buf)
}

/** "21,0975 km" / "1,23564" → 21.0975. Null for anything else. */
export function parseRegisterDistance(text) {
  const m = String(text || '').trim().match(/^(\d+(?:[.,]\d+)?)\s*(?:km)?$/i)
  if (!m) return null
  const km = parseFloat(m[1].replace(',', '.'))
  return Number.isFinite(km) && km > 0 ? km : null
}

/** "2023.05.10" → "2023-05-10". Null when the cell is not such a date. */
export function parseRegisterDate(text) {
  const m = String(text || '').trim().match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/)
  if (!m) return null
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()

/**
 * Parses the decoded page into register rows. Rows that do not carry a distance,
 * a town and a name (separators, headers) are dropped.
 * @returns {{ distance_km: number, town: string, name: string, certified_on: string|null, status: string|null }[]}
 */
export function parseRegister(html) {
  const $ = cheerio.load(html)
  const rows = []
  $('tr').each((_, tr) => {
    const cells = $(tr).find('td').map((__, td) => clean($(td).text())).get()
    if (cells.length < 4) return
    const distance_km = parseRegisterDistance(cells[0])
    const town = cells[1]
    const name = cells[2]
    if (distance_km == null || !town || !name) return
    rows.push({
      distance_km,
      town,
      name,
      certified_on: parseRegisterDate(cells[3]),
      status: clean(cells[4]) || null,
    })
  })
  return rows
}

/**
 * True when the certificate still counts on `onDate` (YYYY-MM-DD): no status at
 * all (any status, typos included, means "no longer held", "expired" or "course
 * changed") and certified less than five years before.
 */
export function isValidCertificate(row, onDate) {
  if (row.status) return false
  if (!row.certified_on) return false
  const [y, m, d] = row.certified_on.split('-').map(Number)
  const expires = `${String(y + VALIDITY_YEARS).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return onDate < expires
}

/** One stable key per register row, for the upsert. */
export function registerRowKey(row) {
  return [row.distance_km, row.town.toLowerCase(), row.name.toLowerCase(), row.certified_on || ''].join('|')
}
