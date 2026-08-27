import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyOutbound,
  normalizeUrl,
  cleanDistances,
  detectEventTypes,
  typesFromTaxonomy,
  hasKidsSignal,
  parseCity,
} from '../src/scrapers/sources/motivato.js'

// Every URL below is a real value harvested from motivato.pl's "Sprawdź zapisy" button on
// 2026-08-27 and checked by following its full redirect chain. The point of these tests is
// that motivato files ALL of them under "zapisy" while they are in fact a mix of
// registration pages, organizer homepages and regulamin documents — the routing is what
// keeps a wrong registration_url out of the DB.

test('routes verified registration-platform hosts to registration_url', () => {
  const cases = [
    'https://dostartu.pl/s-otwinska-dycha-v16762',
    'https://b4sportonline.pl/bieg_na_babia/',
    'https://elektronicznezapisy.pl/event/15274.html',
    'https://liveds.datasport.pl/zawody_files/zawody11477.html',
    'https://bgtimesport.pl/zawody/biegi/id/825',
    'https://superczas.pl/biegobroncowplocka/zapisy',
    'https://competitions.timekeeper.pl/ii-korczynski-polmaraton-gorski',
    'https://chronotex.pl/opis-zawodow/?id_zawodow=1354',
    'https://my.raceresult.com/405447/registration',
    'https://sportmaniacs.com/pl/services/inscription/runkayakbike-2026-87386',
    'https://time-sport.pl/2026/zapisy/zapisy-glucholaski-bieg-gorski-2026.html',
  ]
  for (const url of cases) {
    assert.deepEqual(classifyOutbound(url), { registration_url: url }, url)
  }
})

test('routes organizer-hosted registration subdomains to registration_url', () => {
  for (const url of [
    'https://zapisy.sts-timing.pl/1135/',
    'https://rejestracja.maratonwarszawski.com/pl',
    'https://events.silesiamarathon.pl/',
    'https://formularz.ultimasport.pl/485',
    'https://panel.maratonczykpomiarczasu.pl/bieg-zamoyskiego',
    'https://zapisy.pomerania-sports.pl/',
  ]) {
    assert.deepEqual(classifyOutbound(url), { registration_url: url }, url)
  }
})

test('routes bare organizer sites to website, never registration_url', () => {
  for (const url of [
    'https://maratonwigry.pl/',
    'https://polmaratongdansk.pl/',
    'https://silesiancross.pl/',
    'https://biegniepodleglosci.waw.pl/',
    'https://utm.run/pl/szczebel_cup/',
    'https://biegiwlkp.pl/events/marcelinski-bieg-letni-2026/',
  ]) {
    const out = classifyOutbound(url)
    assert.equal(out.registration_url, undefined, `${url} must not become registration_url`)
    assert.equal(out.website, url)
  }
})

test('a Facebook page lands in website rather than being dropped', () => {
  const url = 'https://www.facebook.com/biegpogminie/'
  assert.deepEqual(classifyOutbound(url), { website: url })
})

test('reclassifies regulamin documents mislabelled as zapisy', () => {
  // Real mislabels: a regulamin PDF and a regulamin HTML page behind "Sprawdź zapisy".
  const pdf = 'https://pifsport.com.pl/wp-content/uploads/2026/04/Regulamin-biegow-M.-BUBULI-2026.pdf'
  assert.deepEqual(classifyOutbound(pdf), { regulamin_url: pdf })

  const page = 'https://polmaratongdansk.pl/regulamin-bieg-na-5-km/'
  assert.deepEqual(classifyOutbound(page), { regulamin_url: page })
})

test('a /zapisy path on a platform host is still registration, not regulamin', () => {
  const url = 'https://pomiarczasuatelier.pl/zapisy/45-ogolnopolski-tomaszowski-bieg/'
  assert.deepEqual(classifyOutbound(url), { registration_url: url })
})

test('repairs the malformed double-scheme href motivato ships', () => {
  // Live value: https://http://h2opolmaraton.pro-run.pl/ — curl returns 000 on it.
  assert.equal(
    normalizeUrl('https://http://h2opolmaraton.pro-run.pl/'),
    'http://h2opolmaraton.pro-run.pl/'
  )
  assert.equal(normalizeUrl('https://http//h2opolmaraton.pro-run.pl/'), 'http://h2opolmaraton.pro-run.pl/')
})

test('strips tracking params and fragments, rejects unusable URLs', () => {
  assert.equal(
    normalizeUrl('https://biegiwlkp.pl/events/poznan-track-day-2026/?fbclid=IwY2xjaw&utm_source=fb'),
    'https://biegiwlkp.pl/events/poznan-track-day-2026/'
  )
  assert.equal(normalizeUrl('https://superczas.pl/x/zapisy#main'), 'https://superczas.pl/x/zapisy')
  assert.equal(normalizeUrl(''), null)
  assert.equal(normalizeUrl('javascript:void(0)'), null)
  assert.equal(normalizeUrl('https://localhost/x'), null)
  assert.deepEqual(classifyOutbound('not a url'), {})
})

test('parses every distance-badge spelling motivato uses', () => {
  assert.equal(cleanDistances(['15,3km']), '15.3 km')
  assert.equal(cleanDistances(['42,2km', '13km']), '42.2 km, 13 km')
  assert.equal(cleanDistances(['5 km', '10 km', '5KM']), '5 km, 10 km')   // deduped
  // Polish word forms — without these Rydułtowy and Maraton Trzech Jezior lose distances.
  assert.equal(cleanDistances(['5 kilometrów', '10 kilometrów']), '5 km, 10 km')
  assert.equal(cleanDistances(['3,5 kilometrowy', '43 kilometrowy', '21 kilometrowy']), '3.5 km, 43 km, 21 km')
  assert.equal(cleanDistances(['400m']), '400 m')
})

test('returns null when motivato puts the event name in the badge slot', () => {
  // Its fallback when it has no distance data — must not be mined for numbers.
  assert.equal(cleanDistances(['II Złotowska Dziesiątka']), null)
  assert.equal(cleanDistances(['Poznańska Piwna Mila #20']), null)
  assert.equal(cleanDistances(['45. Ogólnopolski Tomaszowski Bieg im. Bronisława Malinowskiego']), null)
  assert.equal(cleanDistances([]), null)
})

test('event_types come from the name first, taxonomy only as a single-tag fallback', () => {
  assert.deepEqual(detectEventTypes('Silesian Cross Marathon'), ['trail'])
  assert.deepEqual(detectEventTypes('Bieg Górski Na Błatnią'), ['trail'])
  assert.deepEqual(
    detectEventTypes('X Charytatywny Cross oraz Nordic Walking w Iwoniczu'),
    ['trail', 'nordic walking']
  )
  assert.deepEqual(detectEventTypes('Mistrzowski Marsz z kijami'), ['nordic walking'])
  assert.deepEqual(detectEventTypes('XI Międzynarodowy Bieg Obrońców Płocka'), [])

  // The fallback must never return two style tags: {trail, ultra} against another
  // source's {ultra} is a style-count mismatch in hasDistinguishingConflict, which
  // rejects a correct merge and ships a duplicate. Maraton Wigry is the live case
  // (data-surface="trail", data-distance="maraton ultra gorskie").
  assert.deepEqual(typesFromTaxonomy('trail', 'maraton ultra gorskie'), ['trail'])
  assert.deepEqual(typesFromTaxonomy('mountain', 'polmaraton gorskie'), ['trail'])
  assert.deepEqual(typesFromTaxonomy('road', '10km 5km'), [])
})

test('kids detection catches sub-race labels but not memorial phrasing', () => {
  assert.equal(hasKidsSignal('Bieg Charytatywny PKO'), false)
  // data-search exposes sub-races the title hides.
  assert.equal(hasKidsSignal('bieg charytatywny pko warszawa 5 km biegi dziecięce'), true)
  assert.equal(hasKidsSignal('Biegi dla dzieci'), true)
  assert.equal(hasKidsSignal('MiniKierpce'), true)
  // "in memory of the children of Zamojszczyzna" is an adult memorial race.
  assert.equal(hasKidsSignal('37. Bieg Pokoju Pamięci Dzieci Zamojszczyzny'), false)
})

test('takes the city and discards motivato\'s unreliable voivodeship half', () => {
  assert.equal(parseCity('Brenna, śląskie'), 'Brenna')
  assert.equal(parseCity('Zielona Góra, lubuskie'), 'Zielona Góra')
  assert.equal(parseCity('Łomnica-Zdrój, dolnośląskie'), 'Łomnica-Zdrój')  // region is wrong upstream
  assert.equal(parseCity(''), null)
})
