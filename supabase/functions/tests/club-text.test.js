import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { slugifyClub, normalizeClubName } from '../_shared/clubText.js'

describe('clubText', () => {
  it('slugifyClub folds Polish diacritics and strips punctuation', () => {
    assert.equal(slugifyClub('Górska Drużyna Łódź!'), 'gorska-druzyna-lodz')
    assert.equal(slugifyClub('  ZATYRANI  '), 'zatyrani')
  })
  it('normalizeClubName lowercases + folds but keeps single spaces', () => {
    assert.equal(normalizeClubName('Górska  Drużyna'), 'gorska druzyna')
  })
})
