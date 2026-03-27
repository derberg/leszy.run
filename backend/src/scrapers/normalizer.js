import { geocode } from './geocoder.js'

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

  if (types.length === 0) types.push('bieg')
  return types
}

function parseDistances(distanceText, eventName = '', description = '') {
  const combined = `${distanceText || ''} ${eventName || ''} ${description || ''}`
  if (!combined.trim()) return { distances: [], distances_meters: [] }

  const distances = []
  const meters = []

  function addDistance(km) {
    const rounded = Math.round(km * 10) / 10
    const m = Math.round(km * 1000)
    if (!meters.includes(m) && m > 0 && m < 500000) {
      distances.push(`${rounded} km`)
      meters.push(m)
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
  if ((lower.includes('półmaraton') || lower.includes('polmaraton') || lower.includes('half')) && !meters.includes(21100)) {
    addDistance(21.1)
  }

  if (/\bmaraton\b/.test(lower) && !lower.includes('pół') && !lower.includes('pol') && !lower.includes('ultra') && !lower.includes('half') && !meters.includes(42200)) {
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

  // Cross-country / przełaj events without distance — skip, leave empty
  // Nordic walking without distance — skip

  return { distances, distances_meters: meters.sort((a, b) => a - b) }
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

  const { distances, distances_meters } = parseDistances(raw.distances || '', raw.name, '')
  const eventType = classifyType(raw.name, '', raw.location)
  const cleanedLocation = cleanLocation(raw.location)
  const { lat, lng, voivodeship: geoVoivodeship } = await geocode(cleanedLocation)

  // Voivodeship priority: scraper data > geocoder (Nominatim) > hardcoded city map
  const rawVoivodeship = raw.voivodeship || geoVoivodeship || detectVoivodeship(cleanedLocation || raw.location, raw.name)
  const voivodeship = rawVoivodeship ? rawVoivodeship.replace(/(^|-)(\S)/g, (_, sep, ch) => sep + ch.toUpperCase()) : null

  return {
    name: raw.name.trim(),
    date,
    end_date: raw.end_date ? parseDate(raw.end_date) : null,
    location: cleanedLocation || raw.location || null,
    voivodeship,
    lat,
    lng,
    event_type: eventType,
    distances,
    distances_meters,
    registration_url: raw.registration_url || null,
    registration_deadline: raw.registration_deadline ? parseDate(raw.registration_deadline) : null,
    price_from: null,
    price_to: null,
    website: raw.website || null,
    is_night: eventType.includes('nocny'),
    is_charity: eventType.includes('charytatywny'),
    source: raw.source,
    source_url: raw.source_url || null,
    source_id: raw.source_id || null,
  }
}

export { normalizeEvent, classifyType, parseDistances, parseDate, cleanLocation }
