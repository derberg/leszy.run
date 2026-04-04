import { geocode } from './geocoder.js'

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

/**
 * Clean raw location strings from scrapers before geocoding.
 * Strips appended distances ("Łódź42.195 km," → "Łódź"),
 * date prefixes ("26.04.2026 r.Mońki..." → "Mońki"),
 * and full-description junk.
 */
function cleanLocation(raw) {
  if (!raw) return null
  let loc = raw.trim()

  // Strip distance suffixes: "21.097 km, 10 km, 5 km (nw)" and trailing commas
  loc = loc.replace(/\d+[\.,]?\d*\s*km\.?(\s*\([\w\s]+\))?/gi, '').replace(/,\s*$/, '').trim()

  // Strip leading date patterns: "26.04.2026 r." or "16 maja 2026 r. (sobota) godz. 11.00 -"
  loc = loc.replace(/^\d{1,2}[\./]\d{1,2}[\./]\d{4}\s*r?\.?\s*/i, '').trim()
  loc = loc.replace(/^\d{1,2}\s+\w+\s+\d{4}\s*r?\.?\s*\([^)]*\)\s*(godz\.\s*[\d:.]+\s*[-–]?\s*)?/i, '').trim()

  // If location looks like a full description (too long or starts with "Impreza"), discard
  if (loc.length > 80 || /^impreza\s/i.test(loc) || /^rozpocz[eę]/i.test(loc)) return null

  // Strip trailing description fragments after city name
  // e.g. "Mońki ul. Tysiąclecia 17 (Szkoła Podstawowa...)" — keep just the city-ish part
  const streetMatch = loc.match(/^([A-ZĄĆĘŁŃÓŚŹŻa-ząćęłńóśźż\s-]+?)(?:\s+ul\.\s|\s+al\.\s|\s+os\.\s|\s+pl\.\s)/i)
  if (streetMatch && streetMatch[1].length >= 3) {
    loc = streetMatch[1].trim()
  }

  // Strip "Odszukano imprez:" type junk
  if (/odszukano/i.test(loc)) return null

  return loc.length >= 2 ? loc : null
}

function detectVoivodeship(location, name) {
  if (!location && !name) return null
  const text = `${location || ''} ${name || ''}`.toLowerCase()

  for (const [city, voivodeship] of Object.entries(CITY_TO_VOIVODESHIP)) {
    if (text.includes(city)) return voivodeship
  }
  return null
}

const TYPE_KEYWORDS = {
  trail: [
    // direct trail/cross-country terms
    'trail', 'przełaj', 'przelaj', 'przełajow', 'przelajow', 'cross country',
    'cross', 'kros', 'kross', 'crossow',
    // terrain/mountain
    'terenow', 'górsk', 'gorsk', 'gorsky', 'górami', 'podbiegu',
    // forest/nature
    'leśn', 'lesn', 'puszcz', 'borów', 'borow', 'borem',
    // landscape features
    'szlak', 'szlakiem', 'dolin', 'wąwoz', 'wawoz', 'grzbiet',
    'szczyt', 'przelecz', 'przełęcz', 'skałk', 'skalk',
    // Polish trail regions commonly in event names
    'bieszczad', 'beskid', 'karkonosk', 'tatrzańsk', 'tatrzansk',
    'sudecka', 'sudecki', 'izersk', 'pieniński', 'pieninski',
    'ślężańsk', 'slezansk', 'świętokrzys', 'swietokrzys',
    'jurajsk', 'jura ',
    // off-road / wild
    'bezdroż', 'bezdroz', 'poln',
  ],
  nocny: ['nocny', 'nocna', 'night', 'noc ', 'w noc', 'wieczorn'],
  ocr: ['ocr', 'runmageddon', 'spartan', 'barbarian', 'survival', 'extremaln', 'przeszkod', 'mud', 'tough'],
  nordic: ['nordic', 'nordic walking', 'marsz', 'nw)'],
  ultra: ['ultra', 'ultramaraton'],
  charytatywny: ['charytatywny', 'charytatywn', 'charity', 'dla schroniska', 'dla hospicjum', 'dla dzieci', 'pomagani', 'fundacj'],
}

function classifyType(name, description, location) {
  const text = `${name || ''} ${description || ''} ${location || ''}`.toLowerCase()
  const types = []

  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      types.push(type)
    }
  }

  return types
}

function parseDistances(distanceText, eventName = '', description = '') {
  const combined = `${distanceText || ''} ${eventName || ''} ${description || ''}`
  if (!combined.trim()) return { distances: [] }

  const distances = []
  const seen = new Set()

  function addDistance(km) {
    const rounded = Math.round(km * 10) / 10
    const key = `${rounded}`
    if (!seen.has(key) && rounded > 0 && rounded < 500) {
      distances.push(`${rounded} km`)
      seen.add(key)
    }
  }

  // Match explicit "N km" patterns
  const kmMatches = combined.matchAll(/(\d+[.,]?\d*)\s*km/gi)
  for (const m of kmMatches) {
    addDistance(parseFloat(m[1].replace(',', '.')))
  }

  // Match "Nk" or "N K" patterns common in event names (e.g., "10K", "5K")
  const kMatches = combined.matchAll(/\b(\d+)\s*[kK]\b/g)
  for (const m of kMatches) {
    addDistance(parseInt(m[1]))
  }

  const lower = combined.toLowerCase()

  // Named distances from event names
  if ((lower.includes('półmaraton') || lower.includes('polmaraton') || lower.includes('half')) && !seen.has('21.1')) {
    addDistance(21.1)
  }

  if (/\bmaraton\b/.test(lower) && !lower.includes('pół') && !lower.includes('pol') && !lower.includes('ultra') && !lower.includes('half') && !seen.has('42.2')) {
    addDistance(42.2)
  }

  // Common named distances in Polish event names
  if (lower.includes('piątka') || lower.includes('piatka') || /\b5\b/.test(lower.replace(/\d{4}/, ''))) {
    // Only add 5km if "piątka" is in name (not just any "5")
    if (lower.includes('piątka') || lower.includes('piatka')) addDistance(5)
  }

  if (lower.includes('dziesiątka') || lower.includes('dziesiatka')) {
    addDistance(10)
  }

  // If no km distances found, look for time-based durations (e.g., "4h", "6h", "8h", "12h")
  // Common for timed ultras where participants run for a fixed number of hours
  if (distances.length === 0) {
    const hourMatches = combined.matchAll(/\b(\d{1,2})\s*[hH]\b/g)
    for (const m of hourMatches) {
      const hours = parseInt(m[1])
      const label = `${hours}h`
      if (hours > 0 && hours <= 48 && !seen.has(label)) {
        distances.push(label)
        seen.add(label)
      }
    }
  }

  return { distances }
}

function parseDate(dateText) {
  if (!dateText) return null

  const isoMatch = dateText.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (isoMatch) return isoMatch[0]

  const euMatch = dateText.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/)
  if (euMatch) return `${euMatch[3]}-${euMatch[2].padStart(2, '0')}-${euMatch[1].padStart(2, '0')}`

  const months = {
    stycznia: '01', lutego: '02', marca: '03', kwietnia: '04',
    maja: '05', czerwca: '06', lipca: '07', sierpnia: '08',
    'wrzesnia': '09', 'września': '09', 'pazdziernika': '10', 'października': '10',
    listopada: '11', grudnia: '12',
  }

  for (const [name, num] of Object.entries(months)) {
    const re = new RegExp(`(\\d{1,2})\\s+${name}\\s+(\\d{4})`, 'i')
    const m = dateText.match(re)
    if (m) return `${m[2]}-${num}-${m[1].padStart(2, '0')}`
  }

  return null
}

async function normalizeEvent(raw) {
  const date = parseDate(raw.date)
  if (!date) return null

  const { distances } = parseDistances(raw.distances || '', raw.name, '')
  const eventType = raw.event_type
    ? (Array.isArray(raw.event_type) ? raw.event_type : [raw.event_type])
    : classifyType(raw.name, '', raw.location)
  const cleanedLocation = cleanLocation(raw.location)

  // Use scraper-provided lat/lng if available, otherwise geocode
  let lat = raw.lat || null
  let lng = raw.lng || null
  let geoVoivodeship = null
  if (!lat || !lng) {
    const geo = await geocode(cleanedLocation)
    lat = geo.lat
    lng = geo.lng
    geoVoivodeship = geo.voivodeship
  }

  // Voivodeship priority: scraper data > geocoder (Nominatim) > hardcoded city map
  const rawVoivodeship = raw.voivodeship || geoVoivodeship || detectVoivodeship(cleanedLocation || raw.location, raw.name)
  const voivodeship = rawVoivodeship ? rawVoivodeship.replace(/(^|-)(\S)/g, (_, sep, ch) => sep + ch.toUpperCase()) : null

  return {
    name: raw.name.trim(),
    date,
    registration_deadline: raw.end_date ? parseDate(raw.end_date) : (raw.registration_deadline ? parseDate(raw.registration_deadline) : null),
    location: cleanedLocation || raw.location || null,
    voivodeship,
    lat,
    lng,
    event_type: eventType,
    distances,
    registration_url: raw.registration_url || null,
    price_from: raw.price_from || null,
    price_to: raw.price_to || null,
    website: raw.website || null,
    source: raw.source,
    source_url: raw.source_url || null,
    source_id: raw.source_id || null,
  }
}

export { normalizeEvent, classifyType, parseDistances, parseDate, cleanLocation }
