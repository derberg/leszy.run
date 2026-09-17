import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cheerio from 'cheerio'
import { parseDate, cleanDistances, detectEventTypes, isGenericHeading, parseRow } from '../src/scrapers/sources/biegigorskie.js'

test('a single day and a range both resolve to the first day', () => {
  assert.equal(parseDate('03 października 2026'), '2026-10-03')
  assert.equal(parseDate('02-04 października 2026'), '2026-10-02')
  assert.equal(parseDate('13 – 14 marca 2026'), '2026-03-13')
  assert.equal(parseDate('7 maja 2027'), '2027-05-07')
})

test('an unparseable date is dropped rather than guessed', () => {
  assert.equal(parseDate('termin przybliżony'), null)
  assert.equal(parseDate('03 pażdziernika 2026'), null) // not a month we know
  assert.equal(parseDate(''), null)
})

test('elevation never becomes a distance', () => {
  // The distance cell interleaves distances with climb figures, and "~500mUp"
  // contains "500m". Only a bare number and unit counts.
  assert.equal(
    cleanDistances(['23,2km', '(+/-940m)', '11,6km', '(+/-470m)', 'Vertical']),
    '23.2 km, 11.6 km',
  )
  assert.equal(cleanDistances(['21km', '~500mUp', '30km', '~800mUp']), '21 km, 30 km')
  assert.equal(cleanDistances(['12,5km', '(+650m)']), '12.5 km')
})

test('a distance cell with nothing but elevation yields null', () => {
  assert.equal(cleanDistances(['(+650m)', 'Vertical']), null)
  assert.equal(cleanDistances([]), null)
})

test('style tags come from the icons, not the name', () => {
  // "Bison Ultra-Trail" would tag itself from its name, but most mountain races
  // are named like "Zamczyska Winter Trail" or "Duch Pogórza" and say nothing.
  assert.deepEqual(detectEventTypes(['anglosaski-1.png', 'dlugi.png'], 'Duch Pogórza'), ['trail'])
})

test('the ultra icon adds no tag of its own', () => {
  // Every race here is a mountain race, so trail already says it. Tagging ultra
  // as well only splits this row from a generalist source's {trail} for the same
  // race, because the merge guard compares the style tags as a set.
  assert.deepEqual(detectEventTypes(['ultra-2.png', 'cross-1.png'], 'Duch Pogórza'), ['trail'])
  assert.deepEqual(detectEventTypes(['ultra-2.png'], 'Duch Pogórza'), [])
})

test('a road-marked row gets no trail tag', () => {
  assert.deepEqual(detectEventTypes(['ULICZNY-1.png'], 'Bieg Uliczny'), [])
  assert.deepEqual(detectEventTypes(['ULICZNY-1.png', 'dlugi.png'], 'Bieg Uliczny'), [])
})

test('nordic walking is read from the text, including the Polish phrase', () => {
  assert.ok(detectEventTypes(['dlugi.png'], 'Bieg Zdobywców Marsz Nordic Walking 8.5 km').includes('nordic walking'))
  assert.ok(detectEventTypes(['dlugi.png'], 'Mistrzowski Marsz z kijami').includes('nordic walking'))
})

test('a first line of nothing but category words is a heading', () => {
  assert.equal(isGenericHeading('RAJD PIESZY'), true)
  assert.equal(isGenericHeading('Biegi Górskie'), true)
  assert.equal(isGenericHeading('IX Biegi Górskie Sanok'), false)
  assert.equal(isGenericHeading('Podhalańskie Rajdy Piesze'), false)
  assert.equal(isGenericHeading(''), false)
})

// One table row in the portal's own shape: cells addressed by data-x, values split
// across <br>, icons carrying the discipline.
function row({ icons = [], date = [], place = [], distances = [], name = [], signup = null, signupText = 'ZAPISY', www = null }) {
  const img = src => `<img src="https://www.biegigorskie.pl/wp-content/uploads/2024/12/${src}" />`
  const link = (href, text) => (href ? `<a href="${href}">${text}</a>` : text)
  return cheerio.load(`<table><tr>
    <td data-x="0">${icons.map(img).join('')}</td>
    <td data-x="1">${date.join('<br>')}</td>
    <td data-x="2">${place.join('<br>')}</td>
    <td data-x="3">${distances.join('<br>')}</td>
    <td data-x="4">${link(www, name.join('<br>'))}</td>
    <td data-x="5">Kat.I</td>
    <td data-x="6"></td>
    <td data-x="7">${signup ? link(signup, signupText) : ''}</td>
  </tr></table>`)
}

const POLISH_ROW = {
  icons: ['ultra-2.png', 'anglosaski-1.png'],
  date: ['03', 'października', '2026'],
  place: ['Supraśl', 'Podlasie', 'POLSKA'],
  distances: ['10km', '50km', '100km'],
  name: ['Bison Ultra-Trail'],
  signup: 'https://b4sportonline.pl/bison_ultra_trail/',
  www: 'https://bisonultratrail.pl/',
}

test('a row parses into an event', () => {
  const $ = row(POLISH_ROW)
  const ev = parseRow($, $('tr').get(0))
  assert.equal(ev.name, 'Bison Ultra-Trail')
  assert.equal(ev.date, '2026-10-03')
  assert.equal(ev.location, 'Supraśl')
  assert.equal(ev.distances, '10 km, 50 km, 100 km')
  assert.equal(ev.registration_url, 'https://b4sportonline.pl/bison_ultra_trail/')
  assert.equal(ev.website, 'https://bisonultratrail.pl/')
  assert.deepEqual(ev.event_types, ['trail'])
  assert.equal(ev.source_id, 'bison-ultra-trail-2026-10-03')
})

test('a foreign race is dropped', () => {
  // The calendar carries Slovak and Czech races in the same table.
  const $ = row({ ...POLISH_ROW, place: ['Žilina', 'Malá Fatra', 'SŁOWACJA'] })
  assert.equal(parseRow($, $('tr').get(0)), null)
})

test('a cycling row is dropped by its icon', () => {
  // These names say nothing about the discipline, so only the icon can tell.
  const $ = row({ ...POLISH_ROW, icons: ['kolarz.jpg'] })
  assert.equal(parseRow($, $('tr').get(0)), null)
})

test('a results link is not a registration link', () => {
  // Once an edition has been run, the sign-up cell becomes WYNIKI.
  const $ = row({ ...POLISH_ROW, signup: 'https://wyniki.b4sport.pl/baran-trail-race/m1412.html', signupText: 'WYNIKI' })
  assert.equal(parseRow($, $('tr').get(0)).registration_url, null)
})

test('a heading first line takes its name from the next line', () => {
  const $ = row({ ...POLISH_ROW, name: ['RAJD PIESZY', '„Tam i z Powrotem”'] })
  assert.equal(parseRow($, $('tr').get(0)).name, 'RAJD PIESZY „Tam i z Powrotem”')
})

test('sub-race lines stay out of the name but still feed the tags', () => {
  const $ = row({
    ...POLISH_ROW,
    icons: ['dlugi.png'],
    name: ['Bieg Zdobywców Modyni:', 'Bieg główny 8.5 km', 'Marsz Nordic Walking 8.5 km'],
  })
  const ev = parseRow($, $('tr').get(0))
  assert.equal(ev.name, 'Bieg Zdobywców Modyni')
  assert.ok(ev.event_types.includes('nordic walking'))
})
