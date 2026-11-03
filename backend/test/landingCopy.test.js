import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countPhrase } from '../scripts/lib/landingCopy.js'

test('countPhrase picks the Polish plural form for the count', () => {
  assert.equal(countPhrase(1), '1 bieg')
  assert.equal(countPhrase(3), '3 biegi')
  assert.equal(countPhrase(10), '10 biegów')
  assert.equal(countPhrase(12), '12 biegów')
  assert.equal(countPhrase(22), '22 biegi')
  assert.equal(countPhrase(25), '25 biegów')
})

test('countPhrase inflects type nouns, never a bare lower-cased H1', () => {
  assert.equal(countPhrase(11, 'ocr'), '11 biegów OCR')
  assert.equal(countPhrase(24, 'przelajowe'), '24 biegi przełajowe')
  assert.equal(countPhrase(25, 'przelajowe'), '25 biegów przełajowych')
  assert.equal(countPhrase(2, 'nordic-walking'), '2 marsze nordic walking')
  assert.equal(countPhrase(1, 'darmowe'), '1 darmowy bieg')
  assert.equal(countPhrase(5, 'wydarzenie'), '5 wydarzeń')
})

test('an unknown noun key falls back to "bieg"', () => {
  assert.equal(countPhrase(4, 'nope'), '4 biegi')
})
