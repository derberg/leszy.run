import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { followerNames, splitFollowers } from '../../src/lib/clubFollowers.js'

const members = [
  { user_id: 'a', display_name: 'Zofia Nowak', nickname: null, status: 'active' },
  { user_id: 'b', display_name: 'Anna Kowal', nickname: 'anka', status: 'active' },
  { user_id: 'c', display_name: null, nickname: 'szybki_jan', status: 'active' },
  { user_id: 'd', display_name: null, nickname: null, status: 'active' },
]

describe('followerNames', () => {
  it('names the followers in alphabetical order', () => {
    assert.deepEqual(followerNames(['a', 'b'], members), ['Anna Kowal', 'Zofia Nowak'])
  })

  it('falls back to the nickname, then to a placeholder', () => {
    assert.deepEqual(followerNames(['c', 'd'], members), ['szybki_jan', 'Uczestnik anonimowy'])
  })

  it('skips an id that is no longer on the roster', () => {
    assert.deepEqual(followerNames(['a', 'gone'], members), ['Zofia Nowak'])
  })

  it('survives missing input', () => {
    assert.deepEqual(followerNames(undefined, undefined), [])
  })
})

describe('splitFollowers', () => {
  it('shows everyone when the list is short enough', () => {
    assert.deepEqual(splitFollowers(['A', 'B', 'C'], 3), { shown: ['A', 'B', 'C'], hidden: [] })
  })

  it('keeps the first three and parks the rest behind a counter', () => {
    assert.deepEqual(splitFollowers(['A', 'B', 'C', 'D', 'E'], 3), {
      shown: ['A', 'B', 'C'],
      hidden: ['D', 'E'],
    })
  })
})
