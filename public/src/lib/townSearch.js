// Town lookup for the wizard's „Miejscowość” (Nominatim, Polish settlements).
// TownSearch calls it on Enter, blur or „Szukaj”, never per keystroke:
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
