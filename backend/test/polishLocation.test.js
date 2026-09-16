import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cityFromLocation,
  looksNonPolish,
  declaredVoivodeship,
  postcodeFromLocation,
} from '../src/lib/polishLocation.js'

// Every string below was taken verbatim from scraper_all. The voivodeship each
// one produced before this helper existed is in the comment.

test('keeps a hyphenated city name whole', () => {
  // "Bielsko-Biała" split to "Bielsko" and geocoded to a village in Wielkopolskie.
  assert.equal(cityFromLocation('Bielsko-Biała'), 'Bielsko-Biała')
  assert.equal(cityFromLocation('Kędzierzyn-Koźle'), 'Kędzierzyn-Koźle')
  assert.equal(cityFromLocation('Czechowice-Dziedzice'), 'Czechowice-Dziedzice')
  assert.equal(cityFromLocation('Krynica-Zdrój'), 'Krynica-Zdrój')
  assert.equal(cityFromLocation('Jastrzębie-Zdrój'), 'Jastrzębie-Zdrój')
})

test('a postcode is not a city name', () => {
  // "33-122 Wierzchosławice" split to "33", which Nominatim resolved in Podlaskie.
  assert.equal(cityFromLocation('33-122 Wierzchosławice'), 'Wierzchosławice')
  assert.equal(cityFromLocation('26-006 Nowa Słupia'), 'Nowa Słupia')
})

test('takes the city that follows the postcode, not the street before it', () => {
  assert.equal(cityFromLocation('ul. Nasielska 1B, 05-180 Pomiechówek'), 'Pomiechówek')
  assert.equal(cityFromLocation('Kolano 72a, 83-315 Szymbark'), 'Szymbark')
  assert.equal(
    cityFromLocation('Centrum Rekreacji i Wypoczynku Deczno, Sulnówko 30D, 86-100 Świecie'),
    'Świecie'
  )
  assert.equal(cityFromLocation('„Kraina Orła Białego” Stary Gostyń 49a 63-800 Gostyń'), 'Gostyń')
})

test('ignores a postcode that is followed by a street', () => {
  // The city sits before the postcode here, so the postcode rule must stand down.
  assert.equal(cityFromLocation('Frydek, 43-227, ul. Miodowa 189C'), 'Frydek')
  assert.equal(cityFromLocation('Nowe Chechło 42-622,ul. Rekreacyjna 368'), 'Nowe Chechło')
})

test('cuts a street that follows the city without a comma', () => {
  assert.equal(
    cityFromLocation('78-600 Wałcz al. Zdobywców Wału Pomorskiego 99 COS OPO Wałcz'),
    'Wałcz'
  )
  assert.equal(cityFromLocation('22-440 Krasnobród, ul. Wczasowa 22, stadion MGKS "Igros"'), 'Krasnobród')
})

test('drops administrative prefixes and suffixes', () => {
  assert.equal(cityFromLocation('Rogi 53, 33-386 Gmina Podegrodzie'), 'Podegrodzie')
  assert.equal(cityFromLocation('Tuczno (woj. kujawsko-pomorskie)'), 'Tuczno')
  assert.equal(cityFromLocation('Kozy k.Bielska-Białej'), 'Kozy')
  assert.equal(cityFromLocation('Bukowno (pow. olkuski)'), 'Bukowno')
})

test('keeps the plain cases the old cleanup already got right', () => {
  assert.equal(cityFromLocation('Żary, Źródlana 1'), 'Żary')
  assert.equal(cityFromLocation('Zakroczym, ul. O.H.Koźmińskiego 63'), 'Zakroczym')
  assert.equal(cityFromLocation('Laski, Gmina Izabelin (teren sportowo-rekreacyjny)'), 'Laski')
  assert.equal(cityFromLocation('Kudowa Zdrój, Teatr pod Blachą'), 'Kudowa Zdrój')
  assert.equal(cityFromLocation('Kędzierzyn-Koźle, OP'), 'Kędzierzyn-Koźle')
})

test('returns null when there is no city to find', () => {
  assert.equal(cityFromLocation(null), null)
  assert.equal(cityFromLocation('   '), null)
  assert.equal(cityFromLocation('ul. Nasielska 1B'), null)
})

test('a Czech place name reads as non-Polish', () => {
  assert.equal(looksNonPolish({ location: 'Návsí' }), true)
  assert.equal(looksNonPolish({ location: 'Návsí', website: 'www.navsi.cz' }), true)
  assert.equal(looksNonPolish({ website: 'www.navsi.cz' }), true)
  assert.equal(looksNonPolish({ website: 'https://bezeckyklub.sk/zavod' }), true)
})

test('Polish diacritics never read as non-Polish', () => {
  for (const loc of [
    'Żary', 'Źródlana', 'Łódź', 'Gdańsk', 'Świecie', 'Kędzierzyn-Koźle',
    'Bielsko-Biała', 'Wrocław', 'Poznań', 'Częstochowa', 'Ostrów Mazowiecka',
  ]) {
    assert.equal(looksNonPolish({ location: loc }), false, loc)
  }
})

test('a foreign word in the event name is not evidence of a foreign event', () => {
  // "VI Kurpiowski Pśejåk 2026" is run in Nowogród, Poland, and the Kurpie
  // dialect uses å. Only the location and the website host are evidence.
  assert.equal(looksNonPolish({ location: 'Nowogród', name: 'VI Kurpiowski Pśejåk 2026' }), false)
  assert.equal(looksNonPolish({ location: 'Wrocław', website: 'https://skoda-bieg.pl' }), false)
})

test('reads a voivodeship the organizer declared in the location', () => {
  // There are two Tuczno. The source said which one, so nothing may override it.
  assert.equal(declaredVoivodeship('Tuczno (woj. kujawsko-pomorskie)'), 'Kujawsko-Pomorskie')
  assert.equal(declaredVoivodeship('Nowogród, województwo podlaskie'), 'Podlaskie')
  assert.equal(declaredVoivodeship('Bielsko-Biała'), null)
  assert.equal(declaredVoivodeship(null), null)
})

test('reads the postcode, which disambiguates a repeated village name', () => {
  // Podegrodzie exists in Małopolskie and in Zachodniopomorskie. 33-386 is the
  // Małopolskie one, and only the postcode says so.
  assert.equal(postcodeFromLocation('Rogi 53, 33-386 Gmina Podegrodzie'), '33-386')
  assert.equal(postcodeFromLocation('Bielsko-Biała'), null)
})

test('an inflected adjective in a street name does not declare a voivodeship', () => {
  // COS OPO Wałcz sits on aleja Zdobywców Wału Pomorskiego, in
  // Zachodniopomorskie. "Pomorskiego" is not a declaration.
  assert.equal(
    declaredVoivodeship('78-600 Wałcz al. Zdobywców Wału Pomorskiego 99 COS OPO Wałcz'),
    null
  )
  assert.equal(declaredVoivodeship('woj. kujawsko-pomorskie'), 'Kujawsko-Pomorskie')
  assert.equal(declaredVoivodeship('woj. zachodniopomorskie'), 'Zachodniopomorskie')
  assert.equal(declaredVoivodeship('Gdynia, woj. pomorskie'), 'Pomorskie')
})
