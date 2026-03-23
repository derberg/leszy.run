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

function detectVoivodeship(location, name) {
  if (!location && !name) return null
  const text = `${location || ''} ${name || ''}`.toLowerCase()

  for (const [city, voivodeship] of Object.entries(CITY_TO_VOIVODESHIP)) {
    if (text.includes(city)) return voivodeship
  }
  return null
}

const TYPE_KEYWORDS = {
  trail: ['trail', 'gorski', 'gorsky', 'terenowy'],
  nocny: ['nocny', 'night', 'noc'],
  ocr: ['ocr', 'runmageddon', 'spartan', 'barbarian', 'survival'],
  nordic: ['nordic', 'marsz', 'nordic walking'],
  ultra: ['ultra', 'ultramaraton'],
  charytatywny: ['charytatywny', 'charity', 'dla schroniska', 'dla hospicjum', 'dla dzieci'],
}

function classifyType(name, description = '') {
  const text = `${name} ${description}`.toLowerCase()
  const types = []

  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      types.push(type)
    }
  }

  if (types.length === 0) types.push('uliczny')
  return types
}

function parseDistances(distanceText, eventName = '') {
  const combined = `${distanceText || ''} ${eventName || ''}`
  if (!combined.trim()) return { distances: [], distances_meters: [] }

  const distances = []
  const meters = []

  const kmMatches = combined.matchAll(/(\d+[.,]?\d*)\s*km/gi)
  for (const m of kmMatches) {
    const km = parseFloat(m[1].replace(',', '.'))
    distances.push(`${km} km`)
    meters.push(Math.round(km * 1000))
  }

  const lower = combined.toLowerCase()
  if ((lower.includes('polmaraton') || lower.includes('półmaraton')) && !meters.includes(21100)) {
    distances.push('21.1 km')
    meters.push(21100)
  }

  if (lower.includes('maraton') && !lower.includes('pol') && !lower.includes('pół') && !lower.includes('ultra') && !meters.includes(42200)) {
    distances.push('42.2 km')
    meters.push(42200)
  }

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

  const { distances, distances_meters } = parseDistances(raw.distances || '', raw.name)
  const eventType = classifyType(raw.name, raw.description)
  const { lat, lng } = await geocode(raw.location)

  return {
    name: raw.name.trim(),
    date,
    end_date: raw.end_date ? parseDate(raw.end_date) : null,
    location: raw.location || null,
    voivodeship: raw.voivodeship || detectVoivodeship(raw.location, raw.name),
    lat,
    lng,
    event_type: eventType,
    distances,
    distances_meters,
    description: raw.description || null,
    registration_url: raw.registration_url || null,
    registration_deadline: raw.registration_deadline ? parseDate(raw.registration_deadline) : null,
    price_from: raw.price_from || null,
    price_to: raw.price_to || null,
    organizer: raw.organizer || null,
    website: raw.website || null,
    is_night: eventType.includes('nocny'),
    is_charity: eventType.includes('charytatywny'),
    source: raw.source,
    source_url: raw.source_url || null,
    source_id: raw.source_id || null,
  }
}

export { normalizeEvent, classifyType, parseDistances, parseDate }
