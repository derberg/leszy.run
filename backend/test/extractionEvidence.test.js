import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hasFeeEvidence, hasDeadlineEvidence, dropUnsupportedFields } from '../src/lib/extractionEvidence.js'

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

test('deadline gate', () => {
  assert.equal(hasDeadlineEvidence('Zapisy przyjmowane do 10 września.'), true)
  assert.equal(hasDeadlineEvidence('Bieg odbędzie się bez względu na pogodę.'), false)
})
