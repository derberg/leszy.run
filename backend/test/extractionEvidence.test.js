import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hasFeeEvidence, hasFreeEvidence, hasDeadlineEvidence, dropUnsupportedFields } from '../src/lib/extractionEvidence.js'

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf-8')

test('a real regulamin with a fee passes the fee gate', () => {
  const text = fixture('olawa-regulamin.txt')
  assert.match(text, /opłata startowa 25\s*zł/i)
  assert.equal(hasFeeEvidence(text), true)
})

test('the consent form that produced the 0–500 zł range fails the fee gate', () => {
  assert.equal(hasFeeEvidence(fixture('olawa-consent-form.txt')), false)
})

test('drops an invented price range, keeps everything else', () => {
  const extracted = {
    price_from: 0,
    price_to: 500,
    distances_km: [0.4],
    is_kids: true,
  }
  const dropped = dropUnsupportedFields(extracted, fixture('olawa-consent-form.txt'))
  assert.deepEqual(dropped.sort(), ['price_from', 'price_to'])
  assert.deepEqual(extracted, { distances_km: [0.4], is_kids: true })
})

test('keeps a price the document actually supports', () => {
  const extracted = { price_from: 25, price_to: 25 }
  assert.deepEqual(dropUnsupportedFields(extracted, fixture('olawa-regulamin.txt')), [])
  assert.deepEqual(extracted, { price_from: 25, price_to: 25 })
})

test('null values are left alone — the gate only rejects', () => {
  const extracted = { price_from: null, price_to: null, registration_deadline: null }
  assert.deepEqual(dropUnsupportedFields(extracted, 'nothing relevant here'), [])
})

// zapisyonline:1128, Mityng lekkoatletyczny "Lekkoatletyka dla wszystkich" VOL I
// (2026-10-03). The regulamin says "Udział w Mityngach jest bezpłatny" and uses
// no currency word anywhere in its 10706 characters, so the fee gate dropped the
// correct price_from=0 and the event published with no price.
test('a free race keeps price 0 even though the document names no currency', () => {
  const text = fixture('zapisyonline-1128-regulamin.txt')
  assert.match(text, /Udział w Mityngach jest bezpłatny/)
  assert.equal(hasFeeEvidence(text), false)
  assert.equal(hasFreeEvidence(text), true)

  const extracted = { price_from: 0, price_to: 0, is_kids: true }
  assert.deepEqual(dropUnsupportedFields(extracted, text), [])
  assert.deepEqual(extracted, { price_from: 0, price_to: 0, is_kids: true })
})

test('a free document supports the price 0 and nothing else', () => {
  const text = fixture('zapisyonline-1128-regulamin.txt')
  const extracted = { price_from: 0, price_to: 500 }
  assert.deepEqual(dropUnsupportedFields(extracted, text), ['price_to'])
  assert.deepEqual(extracted, { price_from: 0 })
})

test('free wording outside the entry fee does not open the gate', () => {
  const text = 'Bezpłatny parking przy stadionie. Darmowa woda na trasie.'
  assert.equal(hasFreeEvidence(text), false)

  const extracted = { price_from: 0, price_to: 500 }
  assert.deepEqual(dropUnsupportedFields(extracted, text).sort(), ['price_from', 'price_to'])
})

test('deadline gate', () => {
  assert.equal(hasDeadlineEvidence('Zapisy przyjmowane do 10 września.'), true)
  assert.equal(hasDeadlineEvidence('Bieg odbędzie się bez względu na pogodę.'), false)
})

// A fee only some entrants may pay is not the entry fee.
//
// Verbatim from http://gpclubianka.pl/ogolny/, the regulamin of BIEG
// PAŹDZIERNIKOWY 2026 - GMINA ŁUBIANKA. On 2026-09-29 the regulamin step read
// 15 as price_from and it reached the public calendar, where nobody outside the
// gmina could have paid it.
const LUBIANKA = `XIII. Zasady finansowania: Opłaty wpisowej dokonujemy drogą internetową za pomocą formularza zgłoszeniowego na stronie gplubianka.pl lub w biurze zawodów w dniu biegu.
Wysokość opłaty za pomocą internetowego systemu płatności najpóźniej na pięć dni przed każdym biegiem – 25 zł, w biurze zawodów przed startem – 50 zł
Dla mieszkanek oraz mieszkańców gminy Łubianka przewidziana jest bonifikata:15 zł rejestracja internetowa, 50 zł rejestracja w dniu biegu, 120 zł w przypadku opłacenia całego cyklu z góry).`

test('drops a fee that only residents may pay', () => {
  const extracted = { price_from: 15, price_to: 50 }
  const dropped = dropUnsupportedFields(extracted, LUBIANKA)
  assert.deepEqual(dropped, ['price_from'])
  assert.equal(extracted.price_from, undefined)
  // 50 is stated for everyone in the line above, so it keeps its evidence.
  assert.equal(extracted.price_to, 50)
})

test('keeps the fee an ordinary entrant pays', () => {
  const extracted = { price_from: 25, price_to: 50 }
  assert.deepEqual(dropUnsupportedFields(extracted, LUBIANKA), [])
  assert.equal(extracted.price_from, 25)
  assert.equal(extracted.price_to, 50)
})

test('drops both when both come from the restricted offer', () => {
  const extracted = { price_from: 15, price_to: 120 }
  const dropped = dropUnsupportedFields(extracted, LUBIANKA)
  assert.deepEqual(dropped.sort(), ['price_from', 'price_to'])
})

test('an early-bird tier is open to everyone and survives', () => {
  // The distinction is WHO may pay, not whether the word is a discount. A date
  // tier is a discount anybody can take by entering early.
  const text = 'Opłata startowa: 40 zł do 30 września, 60 zł po tym terminie.'
  const extracted = { price_from: 40, price_to: 60 }
  assert.deepEqual(dropUnsupportedFields(extracted, text), [])
  assert.equal(extracted.price_from, 40)
})

test('other restricted groups are caught too', () => {
  for (const [group, line] of [
    ['members', 'Opłata startowa 80 zł. Członkowie klubu płacą 40 zł.'],
    ['pupils', 'Opłata startowa 80 zł. Uczniowie szkół gminy płacą 40 zł.'],
    ['students', 'Opłata startowa 80 zł. Studenci za okazaniem legitymacji 40 zł.'],
    ['seniors', 'Opłata startowa 80 zł. Seniorzy powyżej 70 lat 40 zł.'],
  ]) {
    const extracted = { price_from: 40, price_to: 80 }
    assert.deepEqual(dropUnsupportedFields(extracted, line), ['price_from'], group)
  }
})

test('a free race is still free', () => {
  // The restriction check must not disturb the 0 that hasFreeEvidence allows.
  const extracted = { price_from: 0 }
  assert.deepEqual(dropUnsupportedFields(extracted, 'Udział w biegu jest bezpłatny.'), [])
  assert.equal(extracted.price_from, 0)
})
