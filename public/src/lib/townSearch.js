// Town lookup for the wizard's „Miejscowość” (Nominatim, Polish settlements).
// TownSearch calls it on Enter, blur or „Pokaż na mapie”, never per keystroke:
// Nominatim's usage policy allows about one request a second.

const MAX = 5

export function townSearchUrl(text) {
  const params = new URLSearchParams({
    q: String(text ?? '').trim(),
    format: 'jsonv2',
    addressdetails: '1',
    countrycodes: 'pl',
    featureType: 'settlement',
    limit: String(MAX),
    'accept-language': 'pl',
  })
  return `https://nominatim.openstreetmap.org/search?${params}`
}

const upper = (s) => s.toLocaleUpperCase('pl-PL')

/** „GM. PILCHOWICE · ŚLĄSKIE” — the form the publish step reads the voivodeship from. */
function areaOf(address = {}) {
  const parts = []
  if (address.municipality) parts.push(address.municipality.replace(/^gmina\s+/i, 'gm. '))
  if (address.state) parts.push(address.state.replace(/^województwo\s+/i, ''))
  return upper(parts.join(' · '))
}

/** Nominatim results → [{ label, area, lat, lng }], deduplicated, at most five. */
export function townCandidates(results) {
  if (!Array.isArray(results)) return []
  const out = []
  const seen = new Set()
  for (const r of results) {
    const lat = Number.parseFloat(r?.lat)
    const lng = Number.parseFloat(r?.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    const a = r.address ?? {}
    const label = a.village || a.town || a.city || a.hamlet || a.suburb || r.name
    if (!label) continue
    const area = areaOf(a)
    const key = `${label}|${area}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ label, area, lat, lng })
    if (out.length === MAX) break
  }
  return out
}

// „Szubin, Stadion Miejski ul. Jana Pawła II 14” pasted into „Miejscowość”: the
// settlement search finds nothing for the whole string, so the part before the
// first comma is looked up as the town and the rest goes to „Szczegóły miejsca”.
export function splitTownInput(text) {
  const s = String(text ?? '').trim()
  const i = s.indexOf(',')
  if (i < 0) return { town: s, rest: '' }
  return { town: s.slice(0, i).trim(), rest: s.slice(i + 1).trim() }
}

const fold = (s) => String(s ?? '').toLocaleLowerCase('pl-PL').replace(/\s+/g, ' ').trim()
// Nominatim finds „Jana Pawła II 14, Szubin” and nothing for „ul. Jana Pawła II 14, Szubin”,
// so a street prefix splits a line: „Stadion Miejski ul. Jana Pawła II 14” is the
// place „Stadion Miejski” and the street „Jana Pawła II 14”.
const STREET_PREFIX = /(?:^|\s+)(?:ul\.|ulica|al\.|aleja|os\.|osiedle|pl\.|plac)\s+/i

/**
 * The parts of „Szczegóły miejsca” worth looking up, each as `{ q, street, name }`:
 * a street with its number first, then a place by its name. At most three, so a
 * long note costs three requests at most.
 */
export function addressQueries(details, town) {
  const t = String(town ?? '').trim()
  if (!t) return []
  const streets = []
  const names = []
  for (const line of String(details ?? '').split(/[\n,;]/)) {
    for (const raw of line.split(STREET_PREFIX)) {
      const part = raw.trim().replace(/[.\s]+$/, '')
      if (part.length < 3) continue
      const m = part.match(/^(.*\D)\s+(\d+[a-z]?(?:\/\d+[a-z]?)?)$/i)
      if (m) streets.push({ q: `${part}, ${t}`, street: m[1].trim(), name: null })
      else names.push({ q: `${part}, ${t}`, street: null, name: part })
    }
  }
  return [...streets, ...names].slice(0, 3)
}

export function addressSearchUrl(q) {
  const params = new URLSearchParams({
    q, format: 'jsonv2', addressdetails: '1', countrycodes: 'pl', limit: '3', 'accept-language': 'pl',
  })
  return `https://nominatim.openstreetmap.org/search?${params}`
}

const townOf = (a = {}) => a.village || a.town || a.city || a.hamlet || a.suburb

/**
 * The pin for one address query, or null. Nominatim answers an address that does
 * not exist with some other point in the town („Wojska Polskiego 1, Gliwice” → a
 * post office on another street), so a result counts only in the picked town and
 * on the street the line names (or, for a line with no number, with that name).
 */
export function addressPin(results, query, town) {
  if (!Array.isArray(results)) return null
  for (const r of results) {
    const lat = Number.parseFloat(r?.lat)
    const lng = Number.parseFloat(r?.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    const a = r.address ?? {}
    if (fold(townOf(a)) !== fold(town)) continue
    const ok = query.street
      ? fold(a.road).endsWith(fold(query.street))
      : fold(r.name) === fold(query.name)
    if (ok) return { lat, lng }
  }
  return null
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

/** The first pin `addressQueries` finds, one request a second; null when none matches. */
export async function findAddressPin(details, town, { fetchImpl = fetch, gapMs = 1000 } = {}) {
  const queries = addressQueries(details, town)
  for (let i = 0; i < queries.length; i++) {
    if (i) await pause(gapMs)
    const res = await fetchImpl(addressSearchUrl(queries[i].q), { headers: { Accept: 'application/json' } })
    const pin = addressPin(await res.json(), queries[i], town)
    if (pin) return pin
  }
  return null
}
