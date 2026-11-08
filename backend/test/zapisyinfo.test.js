import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseEventPage, parseListingIds, buildRow, isRunningEvent, hasKidsSignal, detectEventTypes,
  distancesFromLabel, formatDistances, parsePolishDate, walkPlan, KNOWN_HIGH_ID, LOOKBACK,
} from '../src/scrapers/sources/zapisyinfo.js'

// Trimmed from https://zapisy.info/imprezy/<id>/ on 2026-11-08.
const page = ({
  id, name, place, start, races = [], signup = false, countdown = null, files = '', description = '',
}) => `<html><head><title>Informacje - ${name} | Zapisy.info - aplikacja do zapisów online</title></head><body>
<ul class="nav nav-tabs">
<li class="nav-item"><a class="nav-link active" href="/imprezy/${id}/">Informacje</a></li>
<li class="nav-item"><a class="nav-link" href="/imprezy/${id}/uczestnicy/">Uczestnicy</a></li>
${signup ? `<li class="nav-item"><a class="nav-link" href="/imprezy/${id}/rejestracja_do_imprezy/">Zapisy</a></li>` : ''}
</ul>
<div class="description">${description}</div>
${countdown ? `<div class="ibox"><h5>Do końca rejestracji pozostało:</h5><span id="clock">00 dni 00:00:00</span></div>` : '<div>Rejestracja do imprezy zakończona.</div>'}
<ul class="list-group">
<li class="list-group-item list-group-item-sidebar"><i class="fa fa-check"></i> Miejsce: <strong>${place}</strong></li>
<li class="list-group-item list-group-item-sidebar"><i class="fa fa-check"></i> Początek wydarzenia: <strong>${start}</strong></li>
<li class="list-group-item list-group-item-sidebar"><i class="fa fa-check"></i> Rejestracja od: <strong>18 grudnia 2025 10:00</strong></li>
</ul>
${files}
<ul class="list-group list-group-flush">
${races.map((r, i) => `<li class="list-group-item"><a href="/imprezy/${id}/uczestnicy/dystans/${1500 + i}/"
   class="fw-semibold text-decoration-none">
    ${r}
</a><span class="badge">3</span></li>`).join('\n')}
<li class="list-group-item"><a href="/imprezy/${id}/uczestnicy/" class="fw-bold">Wszyscy</a></li>
</ul>
<footer><a href="/media/Regulamin_Zapisy02012026.pdf">Regulamin strony</a>
<a href="/media/POLITYKA-PRYWATNOSCI-ZAPISYINFO.pdf">Polityka prywatności</a></footer>
${countdown ? `<script>runCountdown('${countdown}');</script>` : ''}
</body></html>`

const PAGE_720 = page({
  id: 720, name: 'Grand Prix Powiatu Kościerskiego na 10 km', place: 'Grzybowski Młyn k. kościerzyny',
  start: '15 listopada 2026 10:00', races: ['10 km - opcja wirtualna', '10 km', '10 km - zawodnicy 70+'],
  signup: true, countdown: '2026-11-11T23:59',
})

const PAGE_718 = page({
  id: 718, name: 'VII Bieg Pocztyliona na 10 km', place: 'Cewice', start: '20 września 2026 13:30',
  races: ['10 km', '10 km - mieszk. gm. Cewice'],
  description: '<p><strong>Miejsce:</strong> Stadion KS Leśnik Cewice, Osiedle na Wzgórzu 13</p>',
  files: `<a href="/media/regulations/vii-bieg-pocztyliona-10-km.pdf">Regulamin wydarzenia</a>
<a href="/media/file/vii-bieg-pocztyliona.jpg">plakat</a>`,
})

const PAGE_733 = page({
  id: 733, name: 'Marsze Nordic Walking - X Festiwal Biegów Polski Północnej', place: 'Wdzydze k. Kościerzyny',
  start: '5 czerwca 2026 18:00',
  races: ['Sobota 5 km (17:03)', 'Wszystkie Marsze', 'Niedziela 1.6 km (14:30)', 'Niedziela 10 km (09:00)', 'Piątek 10 km'],
})

test('Polish genitive month dates become ISO dates', () => {
  assert.equal(parsePolishDate('15 listopada 2026 10:00'), '2026-11-15')
  assert.equal(parsePolishDate('4 października 2026 11:00'), '2026-10-04')
  assert.equal(parsePolishDate('3 maja 2026 12:00'), '2026-05-03')
  assert.equal(parsePolishDate('20 września 2026 13:30'), '2026-09-20')
  assert.equal(parsePolishDate('wkrótce'), null)
  assert.equal(parsePolishDate(null), null)
})

test('/imprezy/ yields the ids of the open events', () => {
  const html = `<a href="/imprezy/">Wydarzenia</a><a href="/imprezy/720/">x</a>
<a href="/imprezy/720/rejestracja_do_imprezy/">Zapisy</a><a href="/imprezy/732/">y</a><a href="/imprezy/732/uczestnicy/">L</a>`
  assert.deepEqual(parseListingIds(html), [720, 732])
  assert.deepEqual(parseListingIds(''), [])
})

test('an open event page: name, date, place, races, sign-up tab and deadline', () => {
  const ev = parseEventPage(PAGE_720, 720)
  assert.equal(ev.name, 'Grand Prix Powiatu Kościerskiego na 10 km')
  assert.equal(ev.date, '2026-11-15')
  assert.equal(ev.location, 'Grzybowski Młyn k. kościerzyny')
  assert.deepEqual(ev.races, ['10 km - opcja wirtualna', '10 km', '10 km - zawodnicy 70+'])
  assert.equal(ev.hostsSignup, true)
  assert.equal(ev.deadline, '2026-11-11')
  // The footer's platform terms are not the event's regulamin.
  assert.equal(ev.regulaminUrl, null)
})

test('the sidebar place wins over a "Miejsce:" line in the description', () => {
  const ev = parseEventPage(PAGE_718, 718)
  assert.equal(ev.location, 'Cewice')
  assert.equal(ev.hostsSignup, false)
  assert.equal(ev.deadline, null)
  assert.equal(ev.regulaminUrl, 'https://zapisy.info/media/regulations/vii-bieg-pocztyliona-10-km.pdf')
})

test('a page without a parseable date is dropped', () => {
  assert.equal(parseEventPage(page({ id: 1, name: 'X', place: 'Y', start: '' }), 1), null)
})

test('distances come from race names and the event name, kilometres and metres', () => {
  assert.deepEqual(distancesFromLabel('Niedziela 1.6 km (14:30)'), [1.6])
  assert.deepEqual(distancesFromLabel('10 km - zawodnicy 70+'), [10])
  assert.deepEqual(distancesFromLabel('Bieg Przedszkolaka 100 m'), [0.1])
  assert.deepEqual(distancesFromLabel('Hard Runner'), [])
  assert.equal(formatDistances(['Grand Prix na 10 km', '10 km - opcja wirtualna', '10 km']), '10 km')
  assert.equal(formatDistances(['Bieg dzieci 400 m', '5 km']), '400 m, 5 km')
  assert.equal(formatDistances(['karnet standardowy']), null)
})

test('buildRow: the event page is the registration URL only when it carries the Zapisy tab', () => {
  const open = buildRow(parseEventPage(PAGE_720, 720))
  assert.equal(open.registration_url, 'https://zapisy.info/imprezy/720/')
  assert.equal(open.source_url, 'https://zapisy.info/imprezy/720/')
  assert.equal(open.source_id, '720')
  assert.equal(open.source, 'zapisyinfo')
  assert.equal(open.distances, '10 km')
  assert.equal(open.registration_deadline, '2026-11-11')
  assert.equal(open.price_from, null)
  assert.equal(open.website, null)
  assert.deepEqual(open.event_types, [])
  assert.equal(open.is_kids, false)

  const closed = buildRow(parseEventPage(PAGE_718, 718))
  assert.equal(closed.registration_url, null)
  assert.equal(closed.source_url, 'https://zapisy.info/imprezy/718/')
})

test('Nordic Walking from the name; distances from every march', () => {
  const row = buildRow(parseEventPage(PAGE_733, 733))
  assert.deepEqual(row.event_types, ['nordic walking'])
  assert.equal(row.distances, '1.6 km, 5 km, 10 km')
})

test('style: one from the name, NW from a race only when the name has none', () => {
  assert.deepEqual(detectEventTypes('Pomerania Ultra Trail'), ['trail', 'ultra'])
  // leśn only at the start of a word (#433): Oleśnica and Oleśno are towns, not forests.
  assert.deepEqual(detectEventTypes('OLEŚNICKI BIEG NIEPODLEGŁOŚCI'), [])
  assert.deepEqual(detectEventTypes('Bieg Olesno'), [])
  assert.deepEqual(detectEventTypes('Leśna Dycha'), ['trail'])
  assert.deepEqual(detectEventTypes('Bieg Lesny'), ['trail'])
  assert.deepEqual(detectEventTypes('Bieg Orłów', ['Marsz Nordic Walking 5 km']), ['nordic walking'])
  assert.deepEqual(detectEventTypes('Cross Festival', ['Marsz Nordic Walking 5 km']), ['trail'])
})

test('kids: Małe Kaszuby Biegają, Bieg Przedszkolaka, biegi dzieci', () => {
  assert.equal(hasKidsSignal('Kartuzy - Małe Kaszuby Biegają 2026'), true)
  assert.equal(hasKidsSignal('Bieg Przedszkolaka 100 m'), true)
  assert.equal(hasKidsSignal('Biegi dzieci i młodzieży „Cross Festival”'), true)
  assert.equal(hasKidsSignal('XXXV Bieg Orłów na 10 km'), false)
})

test('cycling, conferences and whole-cycle passes are not running events', () => {
  const run = (name, location = 'Gdynia') => isRunningEvent({ name, location })
  assert.equal(run('XXXV Bieg Orłów na 10 km'), true)
  assert.equal(run('Marsz Nordic Walking w Czarnej Dąbrówce na 5 km'), true)
  assert.equal(run('MTB Pomerania Maraton Kwidzyn'), false)
  assert.equal(run('MTB Pomerania Maraton, Pomerania Winter Trail'), false)
  assert.equal(run('Pomerania Grvl Race'), false)
  assert.equal(run('Road Race Elbląg'), false)
  assert.equal(run('Rajdy Rowerowe - X Festiwal Biegów Polski Północnej'), false)
  assert.equal(run('Regionalna Konferencja Energetyczna'), false)
  assert.equal(run('Cykl Kaszuby Biegają na 10 km 2026 - zapisy na całość'), false)
  // A cycle pass has "." for a place.
  assert.equal(run('Cykl Kaszuby Biegają', null), false)
})

test('walk window starts LOOKBACK below the highest known id', () => {
  assert.deepEqual(walkPlan({}), { start: KNOWN_HIGH_ID - LOOKBACK, highest: KNOWN_HIGH_ID })
  const plan = walkPlan({ knownIds: new Set(['720', '790', 'junk']), listingIds: [800] })
  assert.deepEqual(plan, { start: 800 - LOOKBACK, highest: 800 })
})
