import { createClient } from '@supabase/supabase-js'
import path from 'node:path'
import { geocode } from '../src/scrapers/geocoder.js'
import { loadPreviousRun, previousFailureIds, tagPersistent, writeRunLog } from './lib/run-log.js'

const SCRIPT_NAME = 'geocode'

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
const dryRun = !process.argv.includes('--apply')

async function main() {
  const startedAt = new Date().toISOString()
  console.log(dryRun ? '=== DRY RUN (use --apply to write to DB) ===' : '=== APPLYING ===')
  const previous = await loadPreviousRun(SCRIPT_NAME)
  const prevIds = previousFailureIds(previous)
  if (previous.file) {
    console.log(`Comparing against previous run: ${previous.file} (${prevIds.size} failures)`)
  }
  // Pull rejected (source, source_id) pairs from calendar_events so we don't
  // try to geocode events the user has already rejected.
  const rejectedKeys = new Set()
  {
    let from = 0
    const pageSize = 1000
    while (true) {
      const { data, error } = await supabase
        .from('calendar_events')
        .select('source, source_id')
        .eq('status', 'rejected')
        .range(from, from + pageSize - 1)
      if (error) { console.error('Rejected fetch error:', error.message); break }
      if (!data || data.length === 0) break
      for (const r of data) rejectedKeys.add(`${r.source}|${r.source_id}`)
      if (data.length < pageSize) break
      from += pageSize
    }
  }

  // Fetch rows missing voivodeship OR lat/lng
  const allRows = []
  let from = 0
  const pageSize = 1000
  while (true) {
    const { data, error } = await supabase
      .from('scraper_all')
      .select('id, name, location, voivodeship, lat, lng, source, source_id, source_url, registration_url, website, regulamin_url')
      .or('voivodeship.is.null,lat.is.null')
      .range(from, from + pageSize - 1)

    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break
    allRows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  const beforeFilter = allRows.length
  const filteredRows = allRows.filter(r => !rejectedKeys.has(`${r.source}|${r.source_id}`))
  const skippedRejected = beforeFilter - filteredRows.length
  if (skippedRejected > 0) console.log(`Skipped ${skippedRejected} rejected event(s) from calendar_events`)
  allRows.length = 0
  allRows.push(...filteredRows)

  const needsVoivodeship = allRows.filter(r => !r.voivodeship).length
  const needsCoords = allRows.filter(r => !r.lat).length
  console.log(`Found ${allRows.length} rows to process (${needsVoivodeship} missing voivodeship, ${needsCoords} missing lat/lng)`)
  let cityMap = 0, geocoded = 0, failed = 0
  const failures = []

  for (const row of allRows) {
    const city = cleanLocation(row.location)
    const needsVoiv = !row.voivodeship
    const needsLatLng = !row.lat

    // Try fast city map first (only resolves voivodeship, not coords)
    if (needsVoiv && !needsLatLng) {
      const fromMap = detectVoivodeshipFromCity(city)
      if (fromMap) {
        if (!dryRun) {
          const { error } = await supabase.from('scraper_all').update({ voivodeship: fromMap }).eq('id', row.id)
          if (error) {
            console.error(`  ERR ${row.name}: ${error.message}`)
            failed++
            failures.push({ id: row.id, name: row.name, location: row.location, source_url: row.source_url, registration_url: row.registration_url, website: row.website, regulamin_url: row.regulamin_url, reason: `db update failed: ${error.message}` })
            continue
          }
        }
        cityMap++; process.stdout.write('.')
        continue
      }
    }

    // Nominatim geocoder — fills voivodeship AND lat/lng
    if (!city) {
      failed++
      failures.push({ id: row.id, name: row.name, location: row.location, source_url: row.source_url, registration_url: row.registration_url, website: row.website, regulamin_url: row.regulamin_url, reason: 'empty location after cleanup' })
      continue
    }

    let geo = await geocode(city)

    // If full string failed, retry with just the first word
    if (!geo.voivodeship && city.includes(' ')) {
      const firstWord = city.split(/\s+/)[0]
      if (firstWord.length >= 3) {
        geo = await geocode(firstWord)
      }
    }

    const updates = {}
    if (needsVoiv && geo.voivodeship) updates.voivodeship = geo.voivodeship
    if (needsVoiv && !geo.voivodeship) {
      // Last resort: city map (even if we needed coords too, at least get voivodeship)
      const fromMap = detectVoivodeshipFromCity(city)
      if (fromMap) updates.voivodeship = fromMap
    }
    if (needsLatLng && geo.lat) { updates.lat = geo.lat; updates.lng = geo.lng }

    if (Object.keys(updates).length > 0) {
      if (!dryRun) {
        const { error } = await supabase.from('scraper_all').update(updates).eq('id', row.id)
        if (error) {
          console.error(`  ERR ${row.name}: ${error.message}`)
          failed++
          failures.push({ id: row.id, name: row.name, location: row.location, source_url: row.source_url, registration_url: row.registration_url, website: row.website, regulamin_url: row.regulamin_url, reason: `db update failed: ${error.message}` })
          continue
        }
      }
      geocoded++; process.stdout.write(geo.lat ? 'G' : '.')
    } else {
      const reason = needsLatLng
        ? `geocoder returned no coordinates for "${city}"`
        : `geocoder returned no voivodeship for "${city}"`
      failed++
      failures.push({ id: row.id, name: row.name, location: row.location, source_url: row.source_url, registration_url: row.registration_url, website: row.website, regulamin_url: row.regulamin_url, reason })
    }
  }

  console.log(`\n\nDone: ${cityMap} city map only, ${geocoded} geocoded, ${failed} failed/no location`)

  const { persistent: persistentCount, fresh: newCount } = tagPersistent(failures, prevIds)

  if (failures.length > 0) {
    console.log(`\n--- Failed events (${failures.length}: ${newCount} new, ${persistentCount} persistent from previous run) ---`)
    for (const f of failures) {
      const tag = f.persistent ? '[PERSISTENT]' : '[NEW]'
      console.log(`  ${tag} "${f.name}"`)
      console.log(`    id:       ${f.id}`)
      console.log(`    location: ${JSON.stringify(f.location)}`)
      console.log(`    reason:   ${f.reason}`)
      if (f.source_url) console.log(`    source:   ${f.source_url}`)
      if (f.registration_url) console.log(`    reg:      ${f.registration_url}`)
      if (f.website) console.log(`    website:  ${f.website}`)
      if (f.regulamin_url) console.log(`    regulamin:${f.regulamin_url}`)
    }
  }

  if (!dryRun) {
    const logFile = await writeRunLog(SCRIPT_NAME, {
      script: SCRIPT_NAME,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      previous_run: previous.file,
      total_rows: allRows.length,
      skipped_rejected: skippedRejected,
      city_map: cityMap,
      geocoded,
      failed,
      new_failures: newCount,
      persistent_failures: persistentCount,
      failures,
    })
    console.log(`\nRun log: ${path.relative(process.cwd(), logFile)}`)
  }
}

main().catch(console.error)
