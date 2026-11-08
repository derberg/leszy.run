import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseListing, parseListingDate, buildName, buildLocation, slugFromUrl, parseDetail, buildRow,
  distancesFromText, pricesFromFees, isRunningEvent, hasKidsSignal, detectEventTypes,
} from '../src/scrapers/sources/catchtime.js'

// One race section of /zawody-aktualne/, trimmed from the 2026-11-08 page.
const section = ({ url, date, name, town, innerLink }) => `
<section data-ha-element-link="{&quot;url&quot;:&quot;${url.replace(/\//g, '\\/')}&quot;,&quot;is_external&quot;:&quot;&quot;,&quot;nofollow&quot;:&quot;&quot;}" class="elementor-section elementor-top-section elementor-element">
<div class="elementor-container">
<div class="elementor-column"><div class="elementor-widget-wrap"><div class="elementor-widget-heading"><div class="elementor-widget-container">
<h2 class="elementor-heading-title elementor-size-default">${date}</h2></div></div></div></div>
<div class="elementor-column"><div class="elementor-widget-wrap"><div class="elementor-widget-heading"><div class="elementor-widget-container">
<h2 class="elementor-heading-title elementor-size-default">${name}</h2></div></div></div></div>
<div class="elementor-column"><div class="premium-countdown" data-settings="{&quot;until&quot;:&quot;2026\\/09\\/13 13:00&quot;}">
<div class="premium-countdown-exp-message premium-addons__v-hidden"><h2><span style="color: #ff0000;">ZAKOŃCZONO</span></h2></div></div></div>
${town === undefined ? '' : `<div class="elementor-column"><div class="elementor-widget-wrap">
<div ${innerLink ? `data-ha-element-link="{&quot;url&quot;:&quot;${innerLink.replace(/\//g, '\\/')}&quot;}"` : ''} class="elementor-widget-heading"><div class="elementor-widget-container">
<h2 class="elementor-heading-title elementor-size-default">${town}</h2></div></div></div></div>`}
</div></section>`

const LISTING = `<html><body>
<section class="elementor-section elementor-top-section"><h2 class="elementor-heading-title">Wybierz zawody</h2></section>
${section({ url: 'https://catchtime.pl/grudusk-na-5-12092026/', date: '12.09.2026', name: 'GRUDUSK NA 5-TKĘ<br>IV EDYCJA', town: 'Grudusk', innerLink: 'https://catchtime.pl/x-makowski-bieg-mikolajkowy-08122024/' })}
${section({ url: 'https://catchtime.pl/wieczorna-piatka-13062026/', date: '20.06.2026', name: 'WIECZORNA PIĄTKA<br>5000 m', town: 'Maków Mazowiecki' })}
${section({ url: 'https://catchtime.pl/zimnar2026/', date: '14.02.2026', name: 'XIV Zimowy Maraton Na Raty<br>VII ETAP', town: 'Przasnysz<br>(lotnisko)' })}
${section({ url: 'https://catchtime.pl/rowerlove-2026/', date: 'lipiec 2026', name: 'VI Wyzwanie ROWE(R)LOVE' })}
${section({ url: 'https://catchtime.pl/16DZ/', date: '15-16.09.2026', name: 'MISTRZOSTWA 16 DYWIZJI ZMECHANIZOWANEJ W BIEGACH PRZAŁAJOWYCH', town: 'Przasnysz' })}
${section({ url: 'https://catchtime.pl/sztafeta-za-jednorozcem-2026', date: '02.10.2026', name: 'Sztafeta Za Jednorożcem', town: 'Jednorożec' })}
${section({ url: 'https://catchtime.pl/makowski-bieg-mikolajkowy-06122026/', date: '06.12.2026', name: 'XII Makowski Bieg Mikołajkowy', town: 'Maków<br>Mazowiecki' })}
</body></html>`

// The race page of the V Bieg Niepodległości (Płońsk), trimmed from 2026-11-08.
const DETAIL = `<html><body><header><a href="https://catchtime.pl/zawody-aktualne/">ZAWODY</a></header><main>
<h2 class="elementor-heading-title">V BIEG NIEPODLEGŁOŚCI</h2>
<h2 class="elementor-heading-title">PŁOŃSK 11.11.2026 r.</h2>
<h2 class="elementor-heading-title">ORGANIZATOR</h2><ul><li>Powiat Płoński;</li></ul>
<h2 class="elementor-heading-title">OPIS ZAWODÓW</h2><p>Biegi odbędą się 11.11.2026 r. w Płońsku</p>
<h2 class="elementor-heading-title">HARMONOGRAM ZAWODÓW:</h2>
<ul><li>12:30 - Otwarcie biura zawodów;</li>
<li>14:00 - Bieg dla przedszkolaków - dystans 100m (wręczenie nagród);</li>
<li>14:15 - Bieg dzieci klas 1-3 - dystans 200m (wręczenie nagród);</li>
<li>15:00 - Start biegu głównego na 5 km (elektroniczny pomiar czasu);</li></ul>
<p>Biuro zawodów będzie czynne w godzinach 12.30–14.30, 300 metrów od startu.</p>
<h2 class="elementor-heading-title">WPISOWE</h2>
<ul><li>Koszt pakietu startowego dla biegów dla dzieci - 5 zł;</li>
<li>Koszt pakietu startowego biegu głównego do dnia 08.11.2026r.- 30 zł W dniu zawodów - 60 zł;</li>
<li>Opłaty należy uiścić przelewem na konto: 80187010452078106611460001 - (Nest Bank)</li></ul>
<h2 class="elementor-heading-title">WARUNKI UCZESTNICTWA</h2>
<ul><li>w biegu głównym mogą uczestniczyć osoby, które ukończą 16 rok życia. Opłata manipulacyjna 20 zł.</li></ul>
<h2 class="elementor-heading-title">REGULAMIN</h2>
<a class="elementor-button" href="https://catchtime.pl/wp-content/uploads/2026/09/V-Bieg-Niepodleglosci-2026.pdf"><span class="elementor-button-text">REGULAMIN</span></a>
<a class="elementor-button" href="https://catchtime.pl/wp-content/uploads/2026/07/Wyniki-OPEN-BIEG-05.07.2026.pdf"><span class="elementor-button-text">WYNIKI</span></a>
<a class="elementor-button" href="https://catchtime.pl/zap5km-bieg-niepodleglosci-11112026/"><span class="elementor-button-text">ZAPISZ SIĘ NA BIEG GŁÓWNY !!!</span></a>
<a class="elementor-button" href="https://catchtime.pl/zapdzieci-bieg-niepodleglosci-11112026/"><span class="elementor-button-text">ZAPISZ SIĘ NA BIEGI DLA DZIECI !!!</span></a>
<a class="elementor-button" href="https://catchtime.pl/opl-bieg-niepodleglosci-11112026/"><span class="elementor-button-text">OPŁACENI</span></a>
</main></body></html>`

// A finished race: no sign-up buttons, results PDFs next to the regulamin.
const DETAIL_PAST = `<html><body><main>
<h2>POGOŃ ZA JEDNOROŻCEM</h2>
<h2>HARMONOGRAM ZAWODÓW</h2><ul><li>10:30 - Start 5 km bieg</li><li>10:31 - Start 5 km nordic walking</li></ul>
<h2>WPISOWE</h2><p>30zł. do 28.02.2026r.<br>70zł. w biurze zawodów</p>
<h2>REGULAMIN</h2>
<a href="https://catchtime.pl/wp-content/uploads/2026/07/Wyniki-OPEN-NW-05.07.2026.pdf"><span class="elementor-button-text">NW 5 KM OPEN</span></a>
<a href="https://catchtime.pl/wp-content/uploads/2026/05/Regulamin-Pogon-za-Jednorozcem-2026v3.pdf"><span class="elementor-button-text">REGULAMIN</span></a>
</main></body></html>`

test('listing dates: a day, a two-day range (first day), a month only (dropped)', () => {
  assert.equal(parseListingDate('11.11.2026'), '2026-11-11')
  assert.equal(parseListingDate('15-16.09.2026'), '2026-09-15')
  assert.equal(parseListingDate('lipiec 2026'), null)
  assert.equal(parseListingDate('31.13.2026'), null)
})

test('a second name line that is only a distance is dropped, an edition is kept', () => {
  assert.equal(buildName(['WIECZORNA PIĄTKA', '5000 m']), 'WIECZORNA PIĄTKA')
  assert.equal(buildName(['XIII Makowska Piętnastka', 'VII Makowska Piątka']), 'XIII Makowska Piętnastka VII Makowska Piątka')
})

test('the town joins its lines and drops a parenthesised venue', () => {
  assert.equal(buildLocation(['Maków', 'Mazowiecki']), 'Maków Mazowiecki')
  assert.equal(buildLocation(['Przasnysz', '(lotnisko)']), 'Przasnysz')
  assert.equal(buildLocation([]), null)
})

test('the slug is the last path segment, with or without a trailing slash', () => {
  assert.equal(slugFromUrl('https://catchtime.pl/sztafeta-za-jednorozcem-2026'), 'sztafeta-za-jednorozcem-2026')
  assert.equal(slugFromUrl('https://catchtime.pl/16DZ/'), '16DZ')
  assert.equal(slugFromUrl('https://example.com/x/'), null)
})

test('the listing reads each section: its own link, the listing date, name and town', () => {
  const races = parseListing(LISTING)
  assert.deepEqual(races.map(r => r.slug), [
    'grudusk-na-5-12092026', 'wieczorna-piatka-13062026', 'zimnar2026', '16DZ',
    'sztafeta-za-jednorozcem-2026', 'makowski-bieg-mikolajkowy-06122026',
  ])
  const grudusk = races[0]
  // The town column links the 2024 Mikołajkowy page; the section link wins.
  assert.equal(grudusk.url, 'https://catchtime.pl/grudusk-na-5-12092026/')
  assert.equal(grudusk.name, 'GRUDUSK NA 5-TKĘ IV EDYCJA')
  assert.equal(grudusk.location, 'Grudusk')
  // The listing date wins over the slug's 13062026.
  assert.equal(races[1].date, '2026-06-20')
  assert.equal(races[1].name, 'WIECZORNA PIĄTKA')
  assert.equal(races[2].location, 'Przasnysz')
  assert.equal(races[3].date, '2026-09-15')
  assert.equal(races[4].url, 'https://catchtime.pl/sztafeta-za-jednorozcem-2026/')
  assert.equal(races[5].location, 'Maków Mazowiecki')
  // The countdown's ZAKOŃCZONO is never a town.
  assert.ok(races.every(r => r.location !== 'ZAKOŃCZONO'))
})

test('distances: km and metres, metres from 1000 as km, no times or "metrów"', () => {
  assert.equal(distancesFromText('dystans 100m\nna 5 km\n4,2 km\n5000 m\n12:30 - biuro\n300 metrów od startu\n25 m'), '100 m, 5 km, 4.2 km')
  assert.equal(distancesFromText('Bieg na 1000 m roczniki 2011-2012'), '1 km')
  assert.equal(distancesFromText(''), null)
})

test('fees: the lowest and highest zł amount; a bank account is not a fee', () => {
  assert.deepEqual(pricesFromFees('- 5 zł;\n- do dnia 08.11.2026r.- 30 zł W dniu zawodów - 60 zł;\nkonto: 80187010452078106611460001'), { priceFrom: 5, priceTo: 60 })
  assert.deepEqual(pricesFromFees('40,00 zł online\n60zł. w biurze'), { priceFrom: 40, priceTo: 60 })
  assert.deepEqual(pricesFromFees(''), { priceFrom: null, priceTo: null })
})

test('the race page gives distances, fees, the first ZAPISZ button and the regulamin', () => {
  const d = parseDetail(DETAIL, 'https://catchtime.pl/bieg-niepodleglosci-11112026/')
  assert.equal(d.distances, '100 m, 200 m, 5 km')
  // The handling fee under WARUNKI is outside the WPISOWE block.
  assert.equal(d.priceFrom, 5)
  assert.equal(d.priceTo, 60)
  assert.equal(d.registrationUrl, 'https://catchtime.pl/zap5km-bieg-niepodleglosci-11112026/')
  assert.equal(d.regulaminUrl, 'https://catchtime.pl/wp-content/uploads/2026/09/V-Bieg-Niepodleglosci-2026.pdf')
})

test('a finished race has no registration link and keeps the regulamin, not a results PDF', () => {
  const d = parseDetail(DETAIL_PAST, 'https://catchtime.pl/pogon-za-jednorozcem-05072026/')
  assert.equal(d.registrationUrl, null)
  assert.equal(d.regulaminUrl, 'https://catchtime.pl/wp-content/uploads/2026/05/Regulamin-Pogon-za-Jednorozcem-2026v3.pdf')
  assert.deepEqual([d.priceFrom, d.priceTo], [30, 70])
})

test('running filter drops cycling by name', () => {
  assert.equal(isRunningEvent('VI Wyzwanie ROWE(R)LOVE'), false)
  assert.equal(isRunningEvent('XII Makowski Bieg Mikołajkowy'), true)
})

test('kids signal from the name or the race page', () => {
  assert.equal(hasKidsSignal('ZaBiegany Brzdąc VIII'), true)
  assert.equal(hasKidsSignal('Bieg dla przedszkolaków - dystans 100m'), true)
  assert.equal(hasKidsSignal('ZAPISZ SIĘ NA BIEGI DLA DZIECI !!!'), true)
  assert.equal(hasKidsSignal('XIII Makowska Piętnastka'), false)
})

test('style from the name; NW from the page only when the name has none', () => {
  assert.deepEqual(detectEventTypes('CROSS SPOD WIATRAKA Korona Ziemi Przasnyskiej'), ['trail'])
  // leśn only at the start of a word (#433): Oleśnica and Oleśno are towns, not forests.
  assert.deepEqual(detectEventTypes('OLEŚNICKI BIEG NIEPODLEGŁOŚCI'), [])
  assert.deepEqual(detectEventTypes('Bieg Olesno'), [])
  assert.deepEqual(detectEventTypes('Leśna Dycha'), ['trail'])
  assert.deepEqual(detectEventTypes('Bieg Lesny'), ['trail'])
  assert.deepEqual(detectEventTypes('MISTRZOSTWA 16 DYWIZJI W BIEGACH PRZAŁAJOWYCH'), ['trail'])
  assert.deepEqual(detectEventTypes('POGOŃ ZA JEDNOROŻCEM', 'Start 5 km nordic walking'), ['nordic walking'])
  assert.deepEqual(detectEventTypes('CROSS SPOD WIATRAKA', 'Start 5 km nordic walking'), ['trail'])
  assert.deepEqual(detectEventTypes('Bieg na Cztery Łapy Bieg Charytatywny'), ['charytatywny'])
})

test('a row carries the listing fields, the page fields and the slug as source_id', () => {
  const race = parseListing(section({
    url: 'https://catchtime.pl/bieg-niepodleglosci-11112026', date: '11.11.2026', name: 'V BIEG NIEPODLEGŁOŚCI', town: 'Płońsk',
  }))[0]
  const row = buildRow(race, parseDetail(DETAIL, race.url))
  assert.deepEqual(row, {
    name: 'V BIEG NIEPODLEGŁOŚCI',
    date: '2026-11-11',
    location: 'Płońsk',
    distances: '100 m, 200 m, 5 km',
    registration_url: 'https://catchtime.pl/zap5km-bieg-niepodleglosci-11112026/',
    registration_deadline: null,
    regulamin_url: 'https://catchtime.pl/wp-content/uploads/2026/09/V-Bieg-Niepodleglosci-2026.pdf',
    website: null,
    is_kids: true,
    event_types: [],
    price_from: 5,
    price_to: 60,
    source: 'catchtime',
    source_id: 'bieg-niepodleglosci-11112026',
    source_url: 'https://catchtime.pl/bieg-niepodleglosci-11112026/',
  })
})
