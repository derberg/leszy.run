import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCards, parseZapisy, parseNonce, isoDate, isRunningEvent, detectEventTypes, hasKidsSignal,
  distanceFromLabel, distancesFromDescription, pageNamesEvent, stripTracking, zapisyBase, buildRow,
} from '../src/scrapers/sources/ststiming.js'

// One card of the EventON AJAX answer (POST /?evo-ajax=eventon_get_events),
// trimmed from the 2026-11-07 response for event 7308.
const card = ({ id, start, title, location, lmlink, organizer, description = '' }) => `
<div id="event_${id}_0" class="eventon_list_event evo_eventtop scheduled  event event_${id}_0" data-event_id="${id}" data-ri="0r">
<div class="evo_event_schema" style="display:none"><a itemprop='url'  href='https://sts-timing.pl/events/slug-${id}/'></a>
<meta itemprop='startDate' content="${start}" /></div>
<p class="desc_trig_outter"><a><span class='evoet_title evcal_desc2 evcal_event_title' itemprop='name'>${title}</span>
<span class='evoet_subtitle evo_below_title'><span class='evcal_event_subtitle' >${location}</span></span></a></p>
<div class='event_description evcal_eventcard ' style="display:none">
${lmlink ? `<div class='evocard_box learnmore'><div class='evo_metarow_learnM evo_metarow_learnmore evorow'>
<a class='evcal_evdata_row evo_clik_row ' href='${lmlink}' ><h3 class='evo_h3 evopad0i'>Zapisy do wydarzenia</h3></a></div></div>` : ''}
<div class="evo_metarow_details"><div class="eventon_full_description">${description}</div></div>
<div class='evcal_evdata_cell' data-loc_tax_id='98'><p class='evo_location_name' style='margin-bottom:10px;'>${location}</p></div>
${organizer ? `<div class="evo_card_organizer"><h4><span class="evo_card_organizer_name_t marb5"><a href="${organizer}">Organizator</a></span></h4></div>` : ''}
</div></div>`

const CARDS = [
  card({
    id: 7308, start: '2026-12-05T10:00+1:00', title: 'BIEGIEM POMAGAM 5 &#8211; BIEG POMOCNIKÓW ŚW. MIKOŁAJA 2026',
    location: 'Warszawa', lmlink: 'https://zapisy.sts-timing.pl/1102/', organizer: 'https://biegiempomagam.pl/',
    description: '<p>Dystans: a. 1 km – trasa oznaczona co 500 metrów<br>b. 5 km<br>c. 10 km</p>',
  }),
  card({
    id: 7282, start: '2026-11-11T11:11+1:00', title: '36. Bieg Niepodległości Warszawa', location: 'Warszawa',
    lmlink: 'https://rejestracja.maratonwarszawski.com/pl/login?redirectTo=/pl',
    organizer: 'https://polmaratonwarszawski.com/kontakt/',
    description: 'A. biegu głównego na dystansie 10 km B. zawodów nordic walking na dystansie ok 5 km. Bieg główny - 10 km.',
  }),
  card({
    id: 7315, start: '2026-12-31T15:00+1:00', title: '22. KRAKOWSKI BIEG SYLWESTROWY', location: 'Kraków',
    lmlink: 'https://krakowskibiegsylwestrowy.pl/zapisz-sie/?fbclid=IwY2xj&utm_source=fb', organizer: 'https://labosport.pl/',
  }),
  card({ id: 7338, start: '2026-12-6T09:00+1:00', title: 'VI Bieg charytatywny „Dobro Wraca”', location: 'Susz' }),
].join('\n')

// The race list and the header links of zapisy.sts-timing.pl/1102/ and /1173/.
const ZAPISY_1102 = `<html><head><title>STS-TIMING.PL - REJESTRACJA</title></head><body>
<h2>BIEGIEM POMAGAM - Bieg pomocników św. Mikołaja</h2>
<a href="lista.php">Lista startowa / Start List</a>
<a href="Oświadczenie opiekuna.pdf">Pobierz zgodę opiekuna na udział w biegu uczestnika poniżej 16 lat</a>
<a href="Upoważnienie do odbioru pakietu startowego.pdf">Pobierz upoważnienie do odbioru pakietu startowego</a>
<a href="https://zapisy.sts-timing.pl/1102/Regulamin Biegiem Pomagam 2026.pdf">Regulamin</a>
<select id="distance" name="distance"><option value="">Wybierz bieg</option>
<option  data-fee="130" value="1">1 KM - 130 zł</option>
<option  data-fee="130" value="2">5 KM - 130 zł</option>
<option  data-fee="130" value="3">10 KM - 130 zł</option></select>
<select id="size"><option value="K_XS">XS</option></select></body></html>`

const ZAPISY_1173 = `<html><body><h2>VII Bieg charytatywny „Dobro Wraca”</h2>
<a href="lista.php">Lista startowa / Start List</a>
<a href="https://zapisy.sts-timing.pl/1173/Regulamin.pdf">Regulamin / Rules</a>
<select id="distance"><option value="">Wybierz bieg</option>
<option  data-fee="0" value="1">dystans ok. 29 km - Start w Suszu - 0 zł</option>
<option  data-fee="0" value="5">dystans ok. 6 km - Start w Łęgowie - 0 zł</option></select></body></html>`

// /1164/ after registration closed: no race list, an opaque regulamin link.
const ZAPISY_1164 = `<html><body><h2>Dycha Ciężkiego</h2><a href="lista.php">Lista startowa / Start List</a>
<a href="adm/pdf/d9fec2a493fb4ef6aa15f9ca76d45bc6.pdf">Regulamin / Rules</a><p>Zapisy online zamknięte!</p></body></html>`

test('the EventON nonce is read from evo_general_params', () => {
  const html = '<script>var evo_general_params = {"ajaxurl":"https://sts-timing.pl/wp-admin/admin-ajax.php","n":"3383dc4439","nonce":"251f4f5db6"};</script>'
  assert.equal(parseNonce(html), '3383dc4439')
  assert.equal(parseNonce('<html></html>'), null)
})

test('start dates are zero-padded ISO dates, unpadded or not', () => {
  assert.equal(isoDate('2026-12-6T09:00+1:00'), '2026-12-06')
  assert.equal(isoDate('2026-11-11T11:11+1:00'), '2026-11-11')
  assert.equal(isoDate(''), null)
})

test('a card carries id, date, name, town, permalink and the Zapisy button', () => {
  const [c] = parseCards(CARDS)
  assert.equal(c.id, '7308')
  assert.equal(c.date, '2026-12-05')
  assert.equal(c.name, 'BIEGIEM POMAGAM 5 – BIEG POMOCNIKÓW ŚW. MIKOŁAJA 2026')
  assert.equal(c.location, 'Warszawa')
  assert.equal(c.permalink, 'https://sts-timing.pl/events/slug-7308/')
  assert.equal(c.lmlink, 'https://zapisy.sts-timing.pl/1102/')
  assert.equal(c.website, 'https://biegiempomagam.pl/')
})

test('an organizer contact page is not the race website', () => {
  const c = parseCards(CARDS).find(x => x.id === '7282')
  assert.equal(c.website, null)
})

test('tracking parameters are stripped from the Zapisy button', () => {
  const c = parseCards(CARDS).find(x => x.id === '7315')
  assert.equal(c.lmlink, 'https://krakowskibiegsylwestrowy.pl/zapisz-sie/')
  assert.equal(stripTracking('https://x.pl/a?id=5&fbclid=1'), 'https://x.pl/a?id=5')
})

test('a card with no Zapisy button has no registration link', () => {
  const c = parseCards(CARDS).find(x => x.id === '7338')
  assert.equal(c.lmlink, null)
  assert.equal(c.date, '2026-12-06')
})

test('the registration page lists distances and fees', () => {
  const z = parseZapisy(ZAPISY_1102, 'https://zapisy.sts-timing.pl/1102/')
  assert.equal(z.distances, '1 km, 5 km, 10 km')
  assert.equal(z.priceFrom, 130)
  assert.equal(z.priceTo, 130)
})

test('a free race printed as "0 zł" is price 0', () => {
  const z = parseZapisy(ZAPISY_1173, 'https://zapisy.sts-timing.pl/1173/')
  assert.equal(z.distances, '29 km, 6 km')
  assert.equal(z.priceFrom, 0)
  assert.equal(z.priceTo, 0)
})

test('the regulamin is the "Regulamin" link, never the guardian consent form, and is URL-encoded', () => {
  const z = parseZapisy(ZAPISY_1102, 'https://zapisy.sts-timing.pl/1102/')
  assert.equal(z.regulaminUrl, 'https://zapisy.sts-timing.pl/1102/Regulamin%20Biegiem%20Pomagam%202026.pdf')
})

test('an opaque regulamin link labelled "Regulamin / Rules" resolves against the event page', () => {
  const z = parseZapisy(ZAPISY_1164, 'https://zapisy.sts-timing.pl/1164/')
  assert.equal(z.regulaminUrl, 'https://zapisy.sts-timing.pl/1164/adm/pdf/d9fec2a493fb4ef6aa15f9ca76d45bc6.pdf')
  assert.equal(z.distances, null)
  assert.equal(z.priceFrom, null)
})

test('a race option gives one distance', () => {
  assert.equal(distanceFromLabel('dystans ok. 29 km - Start w Suszu - 0 zł'), '29 km')
  assert.equal(distanceFromLabel('Półmaraton 21,0975 km - 120 zł'), '21.0975 km')
  assert.equal(distanceFromLabel('Bieg dzieci 400 m - 0 zł'), '400 m')
  assert.equal(distanceFromLabel('Bieg 5000 m'), '5 km')
  assert.equal(distanceFromLabel('Sztafeta - 200 zł'), null)
})

test('the description gives kilometres only', () => {
  assert.equal(distancesFromDescription('1 km – trasa oznaczona co 500 metrów, parking 300 m od startu, 10 km'), '1 km, 10 km')
  assert.equal(distancesFromDescription('Start biegu o godz. 11.00'), null)
})

test('the zapisy base page comes from any STS registration link', () => {
  assert.equal(zapisyBase('https://zapisy.sts-timing.pl/1173'), 'https://zapisy.sts-timing.pl/1173/')
  assert.equal(zapisyBase('https://zapisy.sts-timing.pl/1160/zapisy/'), 'https://zapisy.sts-timing.pl/1160/')
  assert.equal(zapisyBase('https://zapisy.sts-timing.pl/gdyniasport/register.php'), null)
  assert.equal(zapisyBase('https://www.startlist.pl/events/apply_multiple/460/PLN'), null)
})

test('a registration page must name the race', () => {
  assert.equal(pageNamesEvent(ZAPISY_1173, 'VI Bieg charytatywny „Dobro Wraca”'), true)
  assert.equal(pageNamesEvent(ZAPISY_1164, 'Dycha Ciężkiego - Bieg im. ppłk. Maksymiliana Ciężkiego'), true)
  // Gdynia's series form says "Gdyńskie Centrum Sportu": a word that merely
  // contains "gdynski" is not the race.
  const gdyniaSeries = '<html><body>Grand Prix Gdyni 2025 Gdyńskie Centrum Sportu Regulamin</body></html>'
  assert.equal(pageNamesEvent(gdyniaSeries, 'Gdyński Bieg Niepodległości'), false)
})

test('running types are kept, triathlon and cycling are not', () => {
  assert.equal(isRunningEvent({ name: 'Dycha Ciężkiego', types: ['bieg'] }), true)
  assert.equal(isRunningEvent({ name: 'JBL Pho3nix TriathlonSieraków', types: ['triathlon'] }), false)
  assert.equal(isRunningEvent({ name: 'Kujawsko-Pomorskie na Rowery 2026', types: ['bike'] }), false)
  assert.equal(isRunningEvent({ name: 'Relay', types: ['bieg', 'triathlon'] }), false)
  // Untyped: the name decides.
  assert.equal(isRunningEvent({ name: '48. Maraton Warszawski', types: [] }), true)
  assert.equal(isRunningEvent({ name: 'GARMIN ENDURO RACE', types: [] }), false)
  assert.equal(isRunningEvent({ name: 'Garmin Triathlon Tour – Płock', types: [] }), false)
})

test('style comes from the name; an option adds Nordic Walking only when the name has no style', () => {
  assert.deepEqual(detectEventTypes('Iławskie RunO Leśne'), ['trail'])
  assert.deepEqual(detectEventTypes('Bieg Motyli', { options: ['5 km - 50 zł', 'Nordic Walking 5 km - 40 zł'] }), ['nordic walking'])
  assert.deepEqual(detectEventTypes('Cross Leśny', { options: ['Nordic Walking 5 km'] }), ['trail'])
  assert.deepEqual(detectEventTypes('Garmin Ultra Race Gdańsk', { types: ['ultra'] }), ['ultra'])
  assert.deepEqual(detectEventTypes('VI Bieg charytatywny „Dobro Wraca”'), ['charytatywny'])
})

test('a kids race in the name or the race list makes the event kids', () => {
  assert.equal(hasKidsSignal('Bieg dzieci 400 m - 0 zł'), true)
  assert.equal(hasKidsSignal('Biegi Młodzieżowe'), true)
  assert.equal(hasKidsSignal('dystans ok. 29 km - Start w Suszu'), false)
})

test('buildRow assembles the row from the card and the registration page', () => {
  const c = parseCards(CARDS).find(x => x.id === '7338')
  const zapisy = parseZapisy(ZAPISY_1173, 'https://zapisy.sts-timing.pl/1173/')
  const row = buildRow(c, { types: ['bieg'], zapisy, registrationUrl: 'https://zapisy.sts-timing.pl/1173' })
  assert.deepEqual(row, {
    name: 'VI Bieg charytatywny „Dobro Wraca”',
    date: '2026-12-06',
    location: 'Susz',
    distances: '29 km, 6 km',
    registration_url: 'https://zapisy.sts-timing.pl/1173',
    registration_deadline: null,
    regulamin_url: 'https://zapisy.sts-timing.pl/1173/Regulamin.pdf',
    website: null,
    is_kids: false,
    event_types: ['charytatywny'],
    price_from: 0,
    price_to: 0,
    source: 'ststiming',
    source_id: '7338',
    source_url: 'https://sts-timing.pl/events/slug-7338/',
  })
})

test('without a registration page the distances come from the description', () => {
  const c = parseCards(CARDS).find(x => x.id === '7282')
  const row = buildRow(c, { types: [] })
  assert.equal(row.distances, '10 km, 5 km')
  assert.equal(row.registration_url, null)
  assert.equal(row.regulamin_url, null)
})
