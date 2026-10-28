import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupIban } from '../../src/lib/iban.js'

test('groupIban splits a stored IBAN into 4-character groups', () => {
  assert.equal(groupIban('PL61109010140000071219812874'), 'PL61 1090 1014 0000 0712 1981 2874')
})

test('groupIban regroups typed input and uppercases it', () => {
  assert.equal(groupIban(' pl6110 90101400000712 19812874 '), 'PL61 1090 1014 0000 0712 1981 2874')
})

test('groupIban leaves an empty value empty', () => {
  assert.equal(groupIban(''), '')
  assert.equal(groupIban(null), '')
})
