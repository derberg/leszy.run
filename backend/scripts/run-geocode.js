import { createClient } from '@supabase/supabase-js'
import { geocode } from '../src/scrapers/geocoder.js'

// Usage: cd backend && node --env-file=../.env scripts/run-geocode.js
// Fills missing voivodeship (and lat/lng) in scraper_all using city map + Nominatim geocoder.

const CITY_TO_VOIVODESHIP = {
  'warszawa': 'Mazowieckie', 'kraków': 'Małopolskie', 'krakow': 'Małopolskie',
  'wrocław': 'Dolnośląskie', 'wroclaw': 'Dolnośląskie',
  'poznań': 'Wielkopolskie', 'poznan': 'Wielkopolskie',
  'gdańsk': 'Pomorskie', 'gdansk': 'Pomorskie', 'gdynia': 'Pomorskie', 'sopot': 'Pomorskie',
  'łódź': 'Łódzkie', 'lodz': 'Łódzkie',
  'katowice': 'Śląskie', 'gliwice': 'Śląskie', 'sosnowiec': 'Śląskie', 'bytom': 'Śląskie',
  'lublin': 'Lubelskie', 'zamość': 'Lubelskie',
  'białystok': 'Podlaskie', 'bialystok': 'Podlaskie',
  'szczecin': 'Zachodniopomorskie', 'koszalin': 'Zachodniopomorskie',
  'bydgoszcz': 'Kujawsko-Pomorskie', 'toruń': 'Kujawsko-Pomorskie', 'torun': 'Kujawsko-Pomorskie',
  'rzeszów': 'Podkarpackie', 'rzeszow': 'Podkarpackie', 'przemyśl': 'Podkarpackie',
  'olsztyn': 'Warmińsko-Mazurskie', 'elbląg': 'Warmińsko-Mazurskie',
  'zielona góra': 'Lubuskie', 'gorzów': 'Lubuskie',
  'opole': 'Opolskie',
  'kielce': 'Świętokrzyskie',
  'radom': 'Mazowieckie', 'płock': 'Mazowieckie',
  'częstochowa': 'Śląskie', 'czestochowa': 'Śląskie',
  'zakopane': 'Małopolskie', 'nowy sącz': 'Małopolskie',
  'jelenia góra': 'Dolnośląskie', 'legnica': 'Dolnośląskie', 'wałbrzych': 'Dolnośląskie',
  'tarnów': 'Małopolskie', 'tarnow': 'Małopolskie',
  'kalisz': 'Wielkopolskie', 'piła': 'Wielkopolskie',
  'siedlce': 'Mazowieckie', 'ostrołęka': 'Mazowieckie',
  'suwałki': 'Podlaskie',
  'nowy targ': 'Małopolskie',
  'ustrzyki': 'Podkarpackie', 'bieszczady': 'Podkarpackie',
  'kampinos': 'Mazowieckie', 'kampinoska': 'Mazowieckie',
  'trójmiasto': 'Pomorskie', 'trojmiasto': 'Pomorskie',
  'polkowice': 'Dolnośląskie', 'sobótka': 'Dolnośląskie', 'sobotka': 'Dolnośląskie',
  'lwówek': 'Dolnośląskie', 'lwowek': 'Dolnośląskie',
  'jakuszyce': 'Dolnośląskie',
}

function extractCity(location) {
  if (!location) return null
  return location
    .replace(/\s*(ul\.|al\.|os\.|pl\.)\s.*/i, '')
    .split(/[,\-–]/)[0]
    .trim()
}

function detectVoivodeshipFromCity(location) {
  if (!location) return null
  const text = location.toLowerCase()
  for (const [city, voivodeship] of Object.entries(CITY_TO_VOIVODESHIP)) {
    if (text.includes(city)) return voivodeship
  }
  return null
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  // Fetch rows missing voivodeship
  const allRows = []
  let from = 0
  const pageSize = 1000
  while (true) {
    const { data, error } = await supabase
      .from('scraper_all')
      .select('id, name, location, voivodeship, lat, lng')
      .is('voivodeship', null)
      .range(from, from + pageSize - 1)

    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break
    allRows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  console.log(`Found ${allRows.length} rows missing voivodeship`)
  let cityMap = 0, geocoded = 0, failed = 0

  for (const row of allRows) {
    const city = extractCity(row.location)

    // Try fast city map first
    const fromMap = detectVoivodeshipFromCity(city)
    if (fromMap) {
      const updates = { voivodeship: fromMap }
      const { error } = await supabase.from('scraper_all').update(updates).eq('id', row.id)
      if (error) { console.error(`  ERR ${row.name}: ${error.message}`); failed++ }
      else { cityMap++; process.stdout.write('.') }
      continue
    }

    // Fall back to Nominatim geocoder (rate-limited, uses cache)
    if (!city) { failed++; continue }
    const geo = await geocode(city)
    if (geo.voivodeship) {
      const updates = { voivodeship: geo.voivodeship }
      if (!row.lat && geo.lat) { updates.lat = geo.lat; updates.lng = geo.lng }
      const { error } = await supabase.from('scraper_all').update(updates).eq('id', row.id)
      if (error) { console.error(`  ERR ${row.name}: ${error.message}`); failed++ }
      else { geocoded++; process.stdout.write('G') }
    } else {
      console.log(`\n  MISS: "${row.name}" location="${row.location}"`)
      failed++
    }
  }

  console.log(`\n\nDone: ${cityMap} from city map, ${geocoded} geocoded, ${failed} failed/no location`)
}

main().catch(console.error)
