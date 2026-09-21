import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickVenueFallback } from '../src/scrapers/geocoder.js'

// XII Noc STO-nogi Milanówek published with no voivodeship on 2026-09-18. Its
// location is the venue, "Muzeum im. Anny i Jarosława Iwaszkiewiczów w
// Stawisku", and Nominatim answers it with exactly that museum, carrying
// "województwo mazowieckie" and the town Podkowa Leśna in its own address. The
// settlement filter threw the hit away because a museum is not a settlement, and
// the row reached the accept queue with an empty region column.
//
// The filter itself is right and stays. A trail called "Kraków-Częstochowa" once
// became an information board in Świętokrzyskie, and "Rzyki-Praciaki" a bus loop
// in Śląskie, both written to the calendar as the event's region. What separates
// those from the museum is not the kind of place: it is that Nominatim matched
// the museum's actual name and only approximated the other two.

const museum = {
  name: 'Muzeum im. Anny i Jarosława Iwaszkiewiczów w Stawisku',
  addresstype: 'tourism',
  type: 'museum',
  lat: '52.1234',
  lon: '20.6789',
  address: { town: 'Podkowa Leśna', state: 'województwo mazowieckie' },
}

test('a venue Nominatim matched by name gives up its voivodeship', () => {
  const hit = pickVenueFallback([museum], 'Muzeum im. Anny i Jarosława Iwaszkiewiczów w Stawisku')
  assert.equal(hit?.address?.state, 'województwo mazowieckie')
})

test('the country suffix the query is sent with does not spoil the match', () => {
  const hit = pickVenueFallback([museum], 'Muzeum im. Anny i Jarosława Iwaszkiewiczów w Stawisku, Polska')
  assert.ok(hit)
})

// The bus loop that started the settlement filter. Nominatim answered
// "Rzyki-Praciaki" with a stop called "Rzyki Praciaki Pętla" — close, not the
// same, and in the wrong voivodeship.
test('a place whose name only resembles the query is still refused', () => {
  const loop = {
    name: 'Rzyki Praciaki Pętla',
    addresstype: 'highway',
    address: { state: 'województwo śląskie' },
  }
  assert.equal(pickVenueFallback([loop], 'Rzyki-Praciaki, Polska'), null)
})

test('an information board named after several towns is refused', () => {
  const board = {
    name: 'Kraków / Piekoszów / Częstochowa',
    addresstype: 'information',
    address: { state: 'województwo świętokrzyskie' },
  }
  assert.equal(pickVenueFallback([board], 'Kraków-Częstochowa, Polska'), null)
})

// A venue is only allowed to answer for a region when it knows which region it
// is in, and when it sits in a settlement. A hit with neither is a pin on a map.
test('a matched venue with no state answers nothing', () => {
  const hit = { name: 'Chata pod Kopą', addresstype: 'tourism', address: { town: 'Karpacz' } }
  assert.equal(pickVenueFallback([hit], 'Chata pod Kopą'), null)
})

test('a matched venue with no settlement around it answers nothing', () => {
  const hit = { name: 'Chata pod Kopą', addresstype: 'tourism', address: { state: 'województwo dolnośląskie' } }
  assert.equal(pickVenueFallback([hit], 'Chata pod Kopą'), null)
})

// Two venues sharing a name in two voivodeships have no answer from the name
// alone, which is the same rule the settlement path already applies.
test('two matched venues in different voivodeships answer nothing', () => {
  const a = { name: 'Stadion Miejski', addresstype: 'leisure', address: { city: 'Poznań', state: 'województwo wielkopolskie' } }
  const b = { name: 'Stadion Miejski', addresstype: 'leisure', address: { city: 'Rzeszów', state: 'województwo podkarpackie' } }
  assert.equal(pickVenueFallback([a, b], 'Stadion Miejski'), null)
})

test('two matched venues in one voivodeship still answer it', () => {
  const a = { name: 'Stadion Miejski', addresstype: 'leisure', address: { city: 'Poznań', state: 'województwo wielkopolskie' } }
  const b = { name: 'Stadion Miejski', addresstype: 'leisure', address: { city: 'Konin', state: 'województwo wielkopolskie' } }
  assert.equal(pickVenueFallback([a, b], 'Stadion Miejski')?.address?.state, 'województwo wielkopolskie')
})

test('nothing at all is not a match', () => {
  assert.equal(pickVenueFallback([], 'Muzeum'), null)
  assert.equal(pickVenueFallback(null, 'Muzeum'), null)
})
