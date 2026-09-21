import { supabase } from '../lib/supabaseClient.js'

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const RATE_LIMIT_MS = 1100

let lastRequestAt = 0

// Nominatim answers a place query with whatever it has, including things that
// are not places. "Kraków-Częstochowa" (a Jura trail) came back as an
// `information` board in Świętokrzyskie, and "Rzyki-Praciaki" as a `highway`
// bus loop in Śląskie. Both were then written to the calendar as the event's
// region. Only a settlement can name a voivodeship.
const SETTLEMENT_TYPES = new Set([
  'city', 'town', 'village', 'hamlet', 'municipality', 'administrative',
  'borough', 'suburb', 'quarter', 'neighbourhood', 'city_district',
])

// Capitalize the first letter of every word AND of every hyphenated part, so
// the two-part voivodeships come back as "Kujawsko-Pomorskie" rather than
// "Kujawsko-pomorskie". The rest of the pipeline matches these by string.
function capitalizeVoivodeship(v) {
  if (!v) return null
  return v
    .replace(/(?:^|[\s-])\S/g, c => c.toUpperCase())
    .replace(/^Województwo[\s-]+/i, '')
}

// A location that is a venue rather than a settlement.
//
// XII Noc STO-nogi Milanówek starts at "Muzeum im. Anny i Jarosława
// Iwaszkiewiczów w Stawisku". Nominatim answers with exactly that museum and
// carries "województwo mazowieckie" and the town Podkowa Leśna in its own
// address, and SETTLEMENT_TYPES threw the whole hit away, so the row published
// with an empty region column.
//
// The settlement filter is still right and still runs first. The difference
// between this museum and the bus loop that the filter was written for is not
// the kind of place. It is that Nominatim matched the museum's actual NAME,
// while "Rzyki-Praciaki" only ever approximated one ("Rzyki Praciaki Pętla")
// and "Kraków-Częstochowa" matched an information board listing seven towns.
// So a non-settlement is allowed to name a voivodeship only when the organizer
// wrote that place's name, which is also why a restaurant or a car park
// qualifying here is not a problem: it qualifies only when the race genuinely
// starts at one.
//
// It must also know where it is. A venue with no state, or one floating outside
// any settlement, is a pin on a map and answers nothing.
function normalizePlaceName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0142/gi, 'l')
    .toLowerCase()
    .replace(/,\s*pol(ska|and)\s*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function pickVenueFallback(results, query) {
  const wanted = normalizePlaceName(query)
  if (!wanted) return null
  const matched = (Array.isArray(results) ? results : []).filter((r) => {
    if (normalizePlaceName(r?.name) !== wanted) return false
    const address = r?.address || {}
    const settlement = address.city || address.town || address.village || address.municipality
    return Boolean(settlement && (address.state || address.province))
  })
  if (matched.length === 0) return null
  const states = new Set(matched.map((r) => capitalizeVoivodeship(r.address?.state || r.address?.province)))
  if (states.size > 1) return null
  return matched[0]
}

// `postcode` switches Nominatim to its structured endpoint. A postcode inside
// the free-text `q` is simply ignored. "33-386 Podegrodzie" still returns both
// the Małopolskie and the Zachodniopomorskie village. The structured city= +
// postalcode= resolves it to the one place the organizer meant.
async function geocode(locationQuery, { postcode = null, city = null } = {}) {
  if (!locationQuery || !supabase) return { lat: null, lng: null, voivodeship: null, ambiguous: false }

  const { data: cached } = await supabase
    .from('geocode_cache')
    .select('lat, lng, voivodeship')
    .eq('location_query', locationQuery)
    .single()

  // Re-capitalize on the way out: rows cached before the hyphen fix carry
  // "Warmińsko-mazurskie", and the rest of the pipeline matches by string.
  if (cached) {
    return {
      lat: cached.lat,
      lng: cached.lng,
      voivodeship: capitalizeVoivodeship(cached.voivodeship) || null,
      ambiguous: false,
    }
  }

  const now = Date.now()
  const wait = RATE_LIMIT_MS - (now - lastRequestAt)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastRequestAt = Date.now()

  try {
    const params = new URLSearchParams({
      format: 'json',
      limit: '10',
      countrycodes: 'pl',
      addressdetails: '1',
    })
    if (postcode && city) {
      params.set('city', city)
      params.set('postalcode', postcode)
      params.set('country', 'Polska')
    } else {
      params.set('q', `${locationQuery}, Polska`)
    }

    const res = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })

    const all = await res.json()

    // Keep only settlements, then decide whether they agree. A name that names
    // two villages in two voivodeships (Podegrodzie, Tuczno, Przystań) has no
    // answer from the name alone: report the ambiguity and let the caller keep
    // whatever it already had rather than pick one at random.
    const results = Array.isArray(all)
      ? all.filter(r => SETTLEMENT_TYPES.has(r.addresstype) || SETTLEMENT_TYPES.has(r.type))
      : []
    const states = new Set(
      results.map(r => capitalizeVoivodeship(r.address?.state || r.address?.province)).filter(Boolean)
    )
    if (states.size > 1) {
      return { lat: null, lng: null, voivodeship: null, ambiguous: true }
    }

    // A settlement is always preferred. Only when there is none does a venue the
    // organizer named by name get to answer for the region.
    const chosen = results.length > 0 ? results[0] : pickVenueFallback(all, locationQuery)

    if (chosen) {
      const { lat, lon, address } = chosen
      const coords = { lat: parseFloat(lat), lng: parseFloat(lon) }

      // Nominatim search may not return state for small towns — use reverse geocoding as fallback
      // Also check province field — Nominatim sometimes uses it for Polish voivodeships
      let rawState = address?.state || address?.province || null

      if (!rawState) {
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
        lastRequestAt = Date.now()
        try {
          const revRes = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${coords.lat}&lon=${coords.lng}&format=json&addressdetails=1&zoom=5`,
            { headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' } }
          )
          const revData = await revRes.json()
          rawState = revData?.address?.state || revData?.address?.province || null
        } catch {}
      }

      const voivodeship = capitalizeVoivodeship(rawState)

      // Only cache if we got voivodeship — avoid poisoning cache with incomplete results
      if (voivodeship) {
        await supabase.from('geocode_cache').upsert({
          location_query: locationQuery,
          lat: coords.lat,
          lng: coords.lng,
          voivodeship,
        }, { onConflict: 'location_query' })
      }

      return { ...coords, voivodeship, ambiguous: false }
    }
  } catch (err) {
    console.error(`Geocode failed for "${locationQuery}":`, err.message)
  }

  return { lat: null, lng: null, voivodeship: null, ambiguous: false }
}

export { geocode }
