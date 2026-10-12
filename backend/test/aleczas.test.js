import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseListing } from '../src/scrapers/sources/aleczas.js'

// Two cards of https://aleczas.pl/zapisy, as served on 2026-10-12. Before
// registration opens the button is a placeholder: href="#", and the label
// says when sign-up starts.
const entry = (name, distances, dateCity, href, label) => `
<div class="studies-entry mt-4"><div class="entry-detail">
  <div class="entry-content mb-1">
    <h6>${name}</h6>
    <p>${distances}</p>
    <p class="mt-1">${dateCity}</p>
  </div>
  <div class="entry-bottom mt-1 clearfix"><ul class="entry-tag list-style-none">
    <li><a target="_blank" class="button" href="${href}">${label}</a>&nbsp; </li>
  </ul></div>
</div></div>`

const CHOINKA = entry('13. Bieg po Choinkę', 'bieg 5km, bieg z psem 5km, spacer 5 km, biegi dla dzieci',
  '12.12.2026, Mińsk Mazowiecki', '#', 'zapisy od 2.11.2026')
const SIENNICA = entry('6 Siennicki Bieg na Dzień Kobiet', 'bieg 5km, nw 5km, biegi dla dzieci',
  '6.03.2027, Siennica', '#', 'zapisy styczeń 2027')
const JESIENNA = entry('III Jesienna Piątka', 'bieg 5km, bieg z psem 2km',
  '11.10.2026, Mińsk Mazowiecki', 'https://dostartu.pl/iii-jesienna-piatka-2026-v17231', 'zapisz się')

test('a placeholder "#" button is not a registration url', () => {
  const [row] = parseListing(CHOINKA)
  assert.equal(row.registration_url, null)
})

test('a real sign-up link is kept', () => {
  const [row] = parseListing(JESIENNA)
  assert.equal(row.registration_url, 'https://dostartu.pl/iii-jesienna-piatka-2026-v17231')
})

test('a run with a dog and a walk are not distances', () => {
  // "bieg z psem" is canicross and "spacer" is a walk; leszy.run lists neither.
  assert.equal(parseListing(CHOINKA)[0].distances, '5 km')
  assert.equal(parseListing(JESIENNA)[0].distances, '5 km')
})

test('a nordic walking leg at the same length as the run is not listed twice', () => {
  const [row] = parseListing(SIENNICA)
  assert.equal(row.distances, '5 km')
  assert.deepEqual(row.event_types, ['nordic walking'])
})

test('a decimal comma stays inside its distance', () => {
  const html = entry('XIV Cegłowski Bieg i Marsz Niepodległości', 'bieg 11km, nw 5,5 km, biegi dla dzieci',
    '11.11.2026, Cegłów', 'https://dostartu.pl/x', 'zapisz się')
  assert.equal(parseListing(html)[0].distances, '11 km, 5.5 km')
})

test('a walk without poles is not a distance', () => {
  const html = entry('II Memoriał Pawła Jasińskiego', 'bieg 5km, nw 5km, marsz 5 km',
    '18.10.2026, Mińsk Mazowiecki', 'https://dostartu.pl/x', 'zapisz się')
  const [row] = parseListing(html)
  assert.equal(row.distances, '5 km')
  assert.deepEqual(row.event_types, ['nordic walking'])
})
