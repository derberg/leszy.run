import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIban, isValidPolishIban, isValidNip, isValidKrs } from '../../supabase/functions/_shared/payoutValidation.js'

test('F-19 normalizeIban upper-cases and drops spaces', () => {
  assert.equal(normalizeIban('pl61 1090 1014 0000 0712 1981 2874'), 'PL61109010140000071219812874')
})

test('F-19 isValidPolishIban: valid, one digit changed, wrong country, wrong length', () => {
  assert.equal(isValidPolishIban('PL61109010140000071219812874'), true)
  assert.equal(isValidPolishIban('PL61 1090 1014 0000 0712 1981 2874'), true)
  assert.equal(isValidPolishIban('PL61109010140000071219812875'), false)
  assert.equal(isValidPolishIban('DE89370400440532013000'), false)
  assert.equal(isValidPolishIban('PL6110901014000007121981287'), false)
  assert.equal(isValidPolishIban(''), false)
  assert.equal(isValidPolishIban(null), false)
})

test('F-19 isValidNip: valid, bad checksum, bad shape', () => {
  assert.equal(isValidNip('5260250274'), true)
  assert.equal(isValidNip('526-025-02-74'), true)
  assert.equal(isValidNip('5260250275'), false)
  assert.equal(isValidNip('526025027'), false)
  assert.equal(isValidNip('abcdefghij'), false)
})

test('F-19 isValidKrs: ten digits, optional', () => {
  assert.equal(isValidKrs('0000123456'), true)
  assert.equal(isValidKrs(''), true)
  assert.equal(isValidKrs(null), true)
  assert.equal(isValidKrs('12345'), false)
})
