import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { countPl, pluralPl } from '../../src/lib/plural.js'

// Polish count forms (Task 9 review M5: „1 opłaconych” was wrong).
describe('pluralPl', () => {
  const forms = ['opłacone', 'opłacone', 'opłaconych']
  it('1 takes the singular form; 0 and 5…21 the genitive plural', () => {
    assert.equal(pluralPl(1, 'osoba', 'osoby', 'osób'), 'osoba')
    for (const n of [0, 5, 6, 10, 11, 12, 13, 14, 15, 20, 21, 25, 100, 111, 112, 1000]) {
      assert.equal(pluralPl(n, 'osoba', 'osoby', 'osób'), 'osób', String(n))
    }
  })
  it('2–4, 22–24, 102–104 … take the nominative plural; 12–14 and 112–114 do not', () => {
    for (const n of [2, 3, 4, 22, 23, 24, 32, 102, 104, 1002]) assert.equal(pluralPl(n, 'osoba', 'osoby', 'osób'), 'osoby', String(n))
    for (const n of [12, 13, 14, 112, 113, 114, 212]) assert.equal(pluralPl(n, 'osoba', 'osoby', 'osób'), 'osób', String(n))
  })
  it('countPl puts the number in front', () => {
    assert.equal(countPl(1, forms), '1 opłacone')
    assert.equal(countPl(3, forms), '3 opłacone')
    assert.equal(countPl(5, forms), '5 opłaconych')
    assert.equal(countPl(0, forms), '0 opłaconych')
  })
  it('refuses a negative or non-integer count', () => {
    assert.throws(() => pluralPl(-1, 'a', 'b', 'c'))
    assert.throws(() => pluralPl(1.5, 'a', 'b', 'c'))
  })
})
