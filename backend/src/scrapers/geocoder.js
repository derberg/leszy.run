import { supabase } from '../lib/supabaseClient.js'

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const RATE_LIMIT_MS = 1100

let lastRequestAt = 0

async function geocode(locationQuery) {
  if (!locationQuery || !supabase) return { lat: null, lng: null }

  const { data: cached } = await supabase
    .from('geocode_cache')
    .select('lat, lng')
    .eq('location_query', locationQuery)
    .single()

  if (cached) return { lat: cached.lat, lng: cached.lng }

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
    })

    const res = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
    })

    const results = await res.json()

    if (results.length > 0) {
      const { lat, lon } = results[0]
      const coords = { lat: parseFloat(lat), lng: parseFloat(lon) }

      await supabase.from('geocode_cache').upsert({
        location_query: locationQuery,
        lat: coords.lat,
        lng: coords.lng,
      }, { onConflict: 'location_query' })

      return coords
    }
  } catch (err) {
    console.error(`Geocode failed for "${locationQuery}":`, err.message)
  }

  return { lat: null, lng: null }
}

export { geocode }
