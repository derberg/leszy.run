// Reading a city out of a free-text Polish location, and telling a Polish
// location from a foreign one.
//
// WHY THIS IS SHARED CODE
// Every source writes `location` as whatever its organizer typed: a bare city,
// a full postal address, a venue name, a city with a voivodeship in brackets.
// The geocode step used to reduce that to a city by splitting on the first
// comma OR hyphen and cutting everything from the first `ul.`. Both halves of
// that rule were wrong in ways that wrote a wrong region into the public
// calendar:
//
//   "Bielsko-Biała"           → "Bielsko"        → a village in Wielkopolskie
//   "Kędzierzyn-Koźle"        → "Kędzierzyn"     → a village in Mazowieckie
//   "33-122 Wierzchosławice"  → "33"             → whatever Nominatim guessed
//   "ul. Nasielska 1B, 05-180 Pomiechówek" → ""  → no city at all
//
// A hyphen is part of the name in roughly a quarter of Polish town names
// (every -Zdrój spa, every -Dziedzice / -Koźle pair) and it is the separator
// inside a postcode. Neither is a place to cut.

// Street markers. A segment that opens with one of these is an address line,
// not a city, and a city is often followed by one without a comma in between.
const STREET = '(?:ul|al|os|pl|ulica|aleja|osiedle|plac|rondo)'
const STREET_LEADS = new RegExp(`^\\s*${STREET}\\.?\\s`, 'i')
const STREET_FOLLOWS = new RegExp(`\\s+${STREET}\\.?\\s`, 'i')

// Polish postcode. The city follows it in a correctly written address.
const POSTCODE = /\b\d{2}-\d{3}\b/
const POSTCODE_THEN_CITY = /\b\d{2}-\d{3}\b[,\s]+(.+)$/

// "k. Olkusza", "koło Olkusza", "pod Krakowem", "gm. Izabelin", "woj. śląskie".
// The `k.` form turns up written without a following space ("Kozy k.Bielska").
const NEAR_SUFFIX = /\s+(?:k\.\s*|k\s|koło\s|pod\s|nad\s|obok\s|przy\s|gm\.\s*|gmina\s|pow\.\s*|powiat\s|woj\.\s*|województwo\s).*/i
const ADMIN_PREFIX = /^\s*(?:gmina|gm\.|miasto|wieś|m\.)\s+/i

// Trailing house number: "Stary Gostyń 49a", "Sulnówko 30D".
const HOUSE_NUMBER = /\s+\d+[a-z]?$/i

function tidy(segment) {
  if (!segment) return null
  let s = segment.replace(/[„”"'’]/g, ' ')
  s = s.replace(ADMIN_PREFIX, '')
  s = s.replace(NEAR_SUFFIX, '')
  const street = s.search(STREET_FOLLOWS)
  if (street > 0) s = s.slice(0, street)
  s = s.replace(POSTCODE, ' ')
  s = s.replace(HOUSE_NUMBER, '')
  s = s.replace(/\s+/g, ' ').replace(/^[\s,.;-]+|[\s,.;-]+$/g, '')
  return s.length >= 2 ? s : null
}

/**
 * Best guess at the city in a free-text location, for geocoding.
 * Returns null when the string carries no city (a bare street, a venue name).
 */
export function cityFromLocation(raw) {
  if (!raw || typeof raw !== 'string') return null

  // Bracketed asides are never the city: "Tuczno (woj. kujawsko-pomorskie)".
  const base = raw.replace(/\s*\([^)]*\)/g, ' ').trim()
  if (!base) return null

  // A postcode names the city that follows it, unless what follows is a
  // street. Then the city came first: "Frydek, 43-227, ul. Miodowa".
  const afterPostcode = base.match(POSTCODE_THEN_CITY)
  if (afterPostcode && !STREET_LEADS.test(afterPostcode[1])) {
    const city = tidy(afterPostcode[1].split(',')[0])
    if (city) return city
  }

  // Otherwise the city is the first comma-separated segment that is not an
  // address line and not a bare postcode.
  for (const segment of base.split(',')) {
    if (STREET_LEADS.test(segment)) continue
    if (!segment.replace(POSTCODE, '').trim()) continue
    const city = tidy(segment)
    if (city) return city
  }

  return null
}

// Latin letters carrying a diacritic that Polish does not use. Polish has
// exactly ą ć ę ł ń ó ś ź ż, and none of them appear below. A test pins that.
const NON_POLISH_DIACRITIC = /[àáâãäåāăæçčĉďèéêëēĕěėğĥìíîïĩīĭıĵķĺļľňņñòôõöøōŏœřŗšŝşťţþùúûüũūŭůűųŵýÿŷž]/i

// Neighbours whose races turn up on Polish registration platforms.
const FOREIGN_TLD = /\.(?:cz|sk|de|ua|lt|by|hu|at|ru)(?:[/:?#]|$)/i

/**
 * True when the event is run outside Poland.
 *
 * Only the location and the website host count as evidence. The event NAME
 * does not: "VI Kurpiowski Pśejåk" is run in Nowogród and the Kurpie dialect
 * writes å, so a name-based test drops a Polish race. Measured over all 2877
 * scraper_all rows, each of the two signals below fired on exactly one row,
 * a Czech race at Návsí, and on nothing else.
 */
export function looksNonPolish({ location, website } = {}) {
  if (location && NON_POLISH_DIACRITIC.test(location)) return true
  if (website) {
    const host = String(website).replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0]
    if (FOREIGN_TLD.test(host)) return true
  }
  return false
}

// The 16 voivodeships, for reading one back out of free text.
const VOIVODESHIPS = [
  'dolnośląskie', 'kujawsko-pomorskie', 'lubelskie', 'lubuskie', 'łódzkie',
  'małopolskie', 'mazowieckie', 'opolskie', 'podkarpackie', 'podlaskie',
  'pomorskie', 'śląskie', 'świętokrzyskie', 'warmińsko-mazurskie',
  'wielkopolskie', 'zachodniopomorskie',
]

const LETTER = 'a-ząćęłńóśźż'
const BY_LENGTH = [...VOIVODESHIPS].sort((a, b) => b.length - a.length)

function titleCase(v) {
  return v.replace(/(?:^|[\s-])\S/g, c => c.toUpperCase())
}

/**
 * The voivodeship the source wrote into the location string, if any.
 *
 * This outranks anything a geocoder says. There are two Tuczno, one in
 * Zachodniopomorskie and one in Kujawsko-Pomorskie, and elektronicznezapisy
 * publishes "Tuczno (woj. kujawsko-pomorskie)" precisely because the bare name
 * does not identify the place. Nominatim answers the bare name with the larger
 * town and silently contradicts the organizer.
 */
export function declaredVoivodeship(location) {
  if (!location || typeof location !== 'string') return null
  const text = location.toLowerCase()
  // Longest name first, so "kujawsko-pomorskie" is never read as "pomorskie".
  for (const v of BY_LENGTH) {
    // JS \b counts Polish letters as non-word characters, so the boundaries are
    // spelled out. A preceding hyphen is not a boundary either: without that,
    // "pomorskie" matches inside "kujawsko-pomorskie". And the trailing
    // boundary is what keeps "Wału Pomorskiego", a street name in Wałcz,
    // Zachodniopomorskie, from declaring the event to be in Pomorskie.
    const re = new RegExp(`(^|[^${LETTER}-])${v}([^${LETTER}]|$)`)
    if (re.test(text)) return titleCase(v)
  }
  return null
}

/**
 * The Polish postcode in a location, which pins a repeated village name to one
 * place: Podegrodzie exists in Małopolskie and in Zachodniopomorskie, and only
 * the 33-386 in the source string says which.
 */
export function postcodeFromLocation(location) {
  if (!location || typeof location !== 'string') return null
  const m = location.match(POSTCODE)
  return m ? m[0] : null
}
