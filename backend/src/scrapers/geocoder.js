import { supabase } from '../lib/supabaseClient.js'

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const RATE_LIMIT_MS = 1100

let lastRequestAt = 0

// Capitalize first letter of each word
function capitalizeVoivodeship(v) {
  if (!v) return null
  return v.replace(/(?:^|\s)\S/g, c => c.toUpperCase()).replace(/^Województwo\s+/i, '')
}

async function geocode(locationQuery) {
  if (!locationQuery || !supabase) return { lat: null, lng: null, voivodeship: null }

  const { data: cached } = await supabase
    .from('geocode_cache')
    .select('lat, lng, voivodeship')
    .eq('location_query', locationQuery)
    .single()

  if (cached) return { lat: cached.lat, lng: cached.lng, voivodeship: cached.voivodeship || null }

  const now = Date.now()
  const wait = RATE_LIMIT_MS - (now - lastRequestAt)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastRequestAt = Date.now()

  try {
    const params = new URLSearchParams({
      q: `${locationQuery}, Polska`,
      format: 'json',
      limit: '1',
      countrycodes: 'pl',
      addressdetails: '1',
    })

    const res = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })

    const results = await res.json()

    if (results.length > 0) {
      const { lat, lon, address } = results[0]
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

      return { ...coords, voivodeship }
    }
  } catch (err) {
    console.error(`Geocode failed for "${locationQuery}":`, err.message)
  }

  return { lat: null, lng: null, voivodeship: null }
}

export { geocode }
