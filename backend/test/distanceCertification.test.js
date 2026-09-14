import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripCourseCertification, normalizeDistances } from '../scripts/lib/distances.js'

// A PZLA atest certifies that the COURSE was measured. It is a property of the
// route, not part of the distance, and it reached calendar_events verbatim:
// "5 km (ATEST PZLA)" was shown to users as the distance of VI Szybka Piatka
// Jurka Siemaszki. Four zmierzymyczas rows carried one on 2026-09-14.
test('a certification note is dropped from the distance', () => {
  assert.equal(stripCourseCertification('5 km (ATEST PZLA)'), '5 km')
  assert.equal(stripCourseCertification('10 km (atest PZLA)'), '10 km')
  assert.equal(stripCourseCertification('10 km (atest)'), '10 km')
  assert.equal(stripCourseCertification('42.195 km (certyfikat AIMS)'), '42.195 km')
})

// Blanket paren-stripping would destroy real information. Every one of these is
// a genuine parenthetical measured in scraper_all the same day.
test('a parenthetical that carries meaning is kept', () => {
  for (const s of [
    '4 x 100 m (400m)',
    'petla 16 km (12h)',
    '6 km (nordic walking)',
    'do 35 km (RAJD)',
    '60-70 km (WYSCIG)',
  ]) {
    assert.equal(stripCourseCertification(s), s, s)
  }
})

test('a distance with no parenthetical is untouched', () => {
  assert.equal(stripCourseCertification('5 km'), '5 km')
  assert.equal(stripCourseCertification(''), '')
})

// Stripping the note is what lets the token reach the unit normalizer at all —
// before this, "5 km (ATEST PZLA)" matched no pattern and fell through verbatim.
test('the stripped distance then normalizes like any other', () => {
  assert.equal(normalizeDistances('5 km (ATEST PZLA)'), '5 km')
  assert.equal(normalizeDistances('10km (atest PZLA), 500m'), '10 km, 500 m')
})

test('normalization still leaves meaningful parentheticals alone', () => {
  assert.equal(normalizeDistances('6 km (nordic walking)'), '6 km (nordic walking)')
})
