import { createClient } from '@supabase/supabase-js'
import { geocode } from '../src/scrapers/geocoder.js'

// Usage: cd backend && node --env-file=../.env scripts/run-geocode.js
// Fills missing voivodeship (and lat/lng) in scraper_all using city map + Nominatim geocoder.

const CITY_TO_VOIVODESHIP = {
  // Mazowieckie
  'warszawa': 'Mazowieckie', 'radom': 'Mazowieckie', 'płock': 'Mazowieckie',
  'siedlce': 'Mazowieckie', 'ostrołęka': 'Mazowieckie', 'kampinos': 'Mazowieckie',
  'kampinoska': 'Mazowieckie', 'piaseczno': 'Mazowieckie', 'legionowo': 'Mazowieckie',
  'pruszków': 'Mazowieckie', 'pruszkow': 'Mazowieckie', 'grodzisk mazowiecki': 'Mazowieckie',
  'otwock': 'Mazowieckie', 'mińsk mazowiecki': 'Mazowieckie', 'józefów': 'Mazowieckie',
  'konstancin': 'Mazowieckie', 'jabłonna': 'Mazowieckie', 'jablonna': 'Mazowieckie',
  // Małopolskie
  'kraków': 'Małopolskie', 'krakow': 'Małopolskie', 'zakopane': 'Małopolskie',
  'nowy sącz': 'Małopolskie', 'tarnów': 'Małopolskie', 'tarnow': 'Małopolskie',
  'nowy targ': 'Małopolskie', 'wieliczka': 'Małopolskie', 'myślenice': 'Małopolskie',
  'rabka': 'Małopolskie', 'krynica': 'Małopolskie', 'piwniczna': 'Małopolskie',
  'muszyna': 'Małopolskie', 'szczawnica': 'Małopolskie', 'niepołomice': 'Małopolskie',
  'wadowice': 'Małopolskie', 'oświęcim': 'Małopolskie', 'oswiecim': 'Małopolskie',
  'bochnia': 'Małopolskie', 'limanowa': 'Małopolskie',
  // Dolnośląskie
  'wrocław': 'Dolnośląskie', 'wroclaw': 'Dolnośląskie', 'jelenia góra': 'Dolnośląskie',
  'legnica': 'Dolnośląskie', 'wałbrzych': 'Dolnośląskie', 'polkowice': 'Dolnośląskie',
  'sobótka': 'Dolnośląskie', 'sobotka': 'Dolnośląskie', 'lwówek': 'Dolnośląskie',
  'lwowek': 'Dolnośląskie', 'jakuszyce': 'Dolnośląskie', 'szklarska poręba': 'Dolnośląskie',
  'szklarska poreba': 'Dolnośląskie', 'karpacz': 'Dolnośląskie', 'świdnica': 'Dolnośląskie',
  'swidnica': 'Dolnośląskie', 'ząbkowice': 'Dolnośląskie', 'zabkowice': 'Dolnośląskie',
  'kudowa': 'Dolnośląskie', 'polanica': 'Dolnośląskie', 'duszniki': 'Dolnośląskie',
  'kłodzko': 'Dolnośląskie', 'klodzko': 'Dolnośląskie', 'bolesławiec': 'Dolnośląskie',
  'boleslawiec': 'Dolnośląskie', 'oleśnica': 'Dolnośląskie', 'olesnica': 'Dolnośląskie',
  'ślęża': 'Dolnośląskie', 'sleza': 'Dolnośląskie',
  // Wielkopolskie
  'poznań': 'Wielkopolskie', 'poznan': 'Wielkopolskie', 'kalisz': 'Wielkopolskie',
  'piła': 'Wielkopolskie', 'gniezno': 'Wielkopolskie', 'leszno': 'Wielkopolskie',
  'konin': 'Wielkopolskie', 'swarzędz': 'Wielkopolskie', 'swarzedz': 'Wielkopolskie',
  'luboń': 'Wielkopolskie', 'śrem': 'Wielkopolskie', 'srem': 'Wielkopolskie',
  // Pomorskie
  'gdańsk': 'Pomorskie', 'gdansk': 'Pomorskie', 'gdynia': 'Pomorskie', 'sopot': 'Pomorskie',
  'trójmiasto': 'Pomorskie', 'trojmiasto': 'Pomorskie', 'słupsk': 'Pomorskie', 'slupsk': 'Pomorskie',
  'tczew': 'Pomorskie', 'wejherowo': 'Pomorskie', 'rumia': 'Pomorskie', 'reda': 'Pomorskie',
  'władysławowo': 'Pomorskie', 'wladyslawowo': 'Pomorskie',
  'jastrzębia góra': 'Pomorskie', 'jastrzebia gora': 'Pomorskie',
  'hel': 'Pomorskie', 'jastarnia': 'Pomorskie', 'jurata': 'Pomorskie', 'puck': 'Pomorskie',
  'łeba': 'Pomorskie', 'leba': 'Pomorskie', 'ustka': 'Pomorskie',
  'kartuzy': 'Pomorskie', 'kościerzyna': 'Pomorskie', 'koscierzyna': 'Pomorskie',
  'malbork': 'Pomorskie', 'sztutowo': 'Pomorskie', 'stegna': 'Pomorskie',
  'chojnice': 'Pomorskie', 'bytów': 'Pomorskie', 'bytow': 'Pomorskie',
  // Łódzkie
  'łódź': 'Łódzkie', 'lodz': 'Łódzkie', 'piotrków': 'Łódzkie', 'piotrkow': 'Łódzkie',
  'tomaszów mazowiecki': 'Łódzkie', 'bełchatów': 'Łódzkie', 'belchatow': 'Łódzkie',
  'skierniewice': 'Łódzkie', 'zgierz': 'Łódzkie', 'pabianice': 'Łódzkie',
  'spała': 'Łódzkie', 'spala': 'Łódzkie', 'arturówek': 'Łódzkie',
  // Śląskie
  'katowice': 'Śląskie', 'gliwice': 'Śląskie', 'sosnowiec': 'Śląskie', 'bytom': 'Śląskie',
  'częstochowa': 'Śląskie', 'czestochowa': 'Śląskie', 'bielsko': 'Śląskie',
  'rybnik': 'Śląskie', 'tychy': 'Śląskie', 'zabrze': 'Śląskie', 'chorzów': 'Śląskie',
  'chorzow': 'Śląskie', 'jaworzno': 'Śląskie', 'mysłowice': 'Śląskie', 'myslowice': 'Śląskie',
  'żywiec': 'Śląskie', 'zywiec': 'Śląskie', 'wisła': 'Śląskie', 'wisla': 'Śląskie',
  'szczyrk': 'Śląskie', 'ustroń': 'Śląskie', 'ustron': 'Śląskie', 'cieszyn': 'Śląskie',
  'istebna': 'Śląskie', 'brenna': 'Śląskie',
  // Lubelskie
  'lublin': 'Lubelskie', 'zamość': 'Lubelskie', 'chełm': 'Lubelskie', 'chelm': 'Lubelskie',
  'biała podlaska': 'Lubelskie', 'puławy': 'Lubelskie', 'pulawy': 'Lubelskie',
  'świdnik': 'Lubelskie', 'swidnik': 'Lubelskie', 'kazimierz dolny': 'Lubelskie',
  'nałęczów': 'Lubelskie', 'naleczow': 'Lubelskie',
  // Podlaskie
  'białystok': 'Podlaskie', 'bialystok': 'Podlaskie', 'suwałki': 'Podlaskie',
  'łomża': 'Podlaskie', 'lomza': 'Podlaskie', 'augustów': 'Podlaskie', 'augustow': 'Podlaskie',
  'hajnówka': 'Podlaskie', 'hajnowka': 'Podlaskie', 'supraśl': 'Podlaskie', 'suprasl': 'Podlaskie',
  'białowieża': 'Podlaskie', 'bialowieza': 'Podlaskie',
  // Zachodniopomorskie
  'szczecin': 'Zachodniopomorskie', 'koszalin': 'Zachodniopomorskie',
  'świnoujście': 'Zachodniopomorskie', 'swinoujscie': 'Zachodniopomorskie',
  'międzyzdroje': 'Zachodniopomorskie', 'miedzyzdroje': 'Zachodniopomorskie',
  'kołobrzeg': 'Zachodniopomorskie', 'kolobrzeg': 'Zachodniopomorskie',
  'stargard': 'Zachodniopomorskie', 'police': 'Zachodniopomorskie',
  'mielno': 'Zachodniopomorskie', 'darłowo': 'Zachodniopomorskie', 'darlowo': 'Zachodniopomorskie',
  'rewal': 'Zachodniopomorskie', 'dziwnów': 'Zachodniopomorskie', 'dziwnow': 'Zachodniopomorskie',
  // Kujawsko-Pomorskie
  'bydgoszcz': 'Kujawsko-Pomorskie', 'toruń': 'Kujawsko-Pomorskie', 'torun': 'Kujawsko-Pomorskie',
  'włocławek': 'Kujawsko-Pomorskie', 'wloclawek': 'Kujawsko-Pomorskie',
  'grudziądz': 'Kujawsko-Pomorskie', 'grudziadz': 'Kujawsko-Pomorskie',
  'inowrocław': 'Kujawsko-Pomorskie', 'inowroclaw': 'Kujawsko-Pomorskie',
  'ciechocinek': 'Kujawsko-Pomorskie', 'brodnica': 'Kujawsko-Pomorskie',
  // Podkarpackie
  'rzeszów': 'Podkarpackie', 'rzeszow': 'Podkarpackie', 'przemyśl': 'Podkarpackie',
  'ustrzyki': 'Podkarpackie', 'bieszczady': 'Podkarpackie',
  'krosno': 'Podkarpackie', 'sanok': 'Podkarpackie', 'solina': 'Podkarpackie',
  'lesko': 'Podkarpackie', 'cisna': 'Podkarpackie', 'wetlina': 'Podkarpackie',
  'dukla': 'Podkarpackie', 'arłamów': 'Podkarpackie', 'arlamow': 'Podkarpackie',
  // Warmińsko-Mazurskie
  'olsztyn': 'Warmińsko-Mazurskie', 'elbląg': 'Warmińsko-Mazurskie',
  'ełk': 'Warmińsko-Mazurskie', 'elk': 'Warmińsko-Mazurskie',
  'giżycko': 'Warmińsko-Mazurskie', 'gizycko': 'Warmińsko-Mazurskie',
  'mrągowo': 'Warmińsko-Mazurskie', 'mragowo': 'Warmińsko-Mazurskie',
  'mikołajki': 'Warmińsko-Mazurskie', 'mikolajki': 'Warmińsko-Mazurskie',
  'ostróda': 'Warmińsko-Mazurskie', 'ostroda': 'Warmińsko-Mazurskie',
  'iława': 'Warmińsko-Mazurskie', 'ilawa': 'Warmińsko-Mazurskie',
  // Lubuskie
  'zielona góra': 'Lubuskie', 'gorzów': 'Lubuskie',
  'świebodzin': 'Lubuskie', 'swiebodzin': 'Lubuskie',
  'międzyrzecz': 'Lubuskie', 'miedzyrzecz': 'Lubuskie',
  // Opolskie
  'opole': 'Opolskie', 'nysa': 'Opolskie', 'kędzierzyn': 'Opolskie', 'kedzierzyn': 'Opolskie',
  'brzeg': 'Opolskie',
  // Świętokrzyskie
  'kielce': 'Świętokrzyskie', 'sandomierz': 'Świętokrzyskie',
  'ostrowiec': 'Świętokrzyskie', 'starachowice': 'Świętokrzyskie',
  'święty krzyż': 'Świętokrzyskie', 'swiety krzyz': 'Świętokrzyskie',
  'ameliówka': 'Świętokrzyskie', 'ameliowka': 'Świętokrzyskie',
}

function cleanLocation(raw) {
  if (!raw) return null
  let loc = raw.trim()
  // Strip street addresses
  loc = loc.replace(/\s*(ul\.|al\.|os\.|pl\.)\s.*/i, '')
  // Take first part before comma/dash
  loc = loc.split(/[,\-–]/)[0].trim()
  // Strip Polish "near" suffixes: "k Olkusza", "k. Olkusza", "koło Olkusza", "pod Krakowem", "nad Wisłą"
  loc = loc.replace(/\s+(?:k\.?\s|koło\s|pod\s|nad\s|obok\s|przy\s|gm\.\s|gmina\s|pow\.\s|powiat\s|woj\.\s).*/i, '').trim()
  // Strip parenthetical: "Bukowno (pow. olkuski)"
  loc = loc.replace(/\s*\(.*\)/, '').trim()
  return loc.length >= 2 ? loc : null
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
    const city = cleanLocation(row.location)

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

    let geo = await geocode(city)

    // If full string failed, retry with just the first word (e.g. "Bukowno" from "Bukowno k Olkusza")
    if (!geo.voivodeship && city.includes(' ')) {
      const firstWord = city.split(/\s+/)[0]
      if (firstWord.length >= 3) {
        geo = await geocode(firstWord)
      }
    }

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
