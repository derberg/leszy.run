import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { usernameChangeError } from '../_shared/usernameChange.js'

describe('usernameChangeError', () => {
  it('lets a new account claim its first username', () => {
    assert.equal(usernameChangeError(null, 'ania_biega'), null)
    assert.equal(usernameChangeError(undefined, 'ania_biega'), null)
    assert.equal(usernameChangeError('', 'ania_biega'), null)
  })

  it('lets a request that repeats the current username through', () => {
    // The settings page re-sends the whole profile; asking for what you already
    // have is not a change.
    assert.equal(usernameChangeError('ania_biega', 'ania_biega'), null)
    assert.equal(usernameChangeError('ania_biega', ' Ania_Biega '), null)
  })

  it('refuses a real change once a username exists', () => {
    const err = usernameChangeError('ania_biega', 'ania_b')
    assert.ok(err, 'a change must be refused')
    assert.match(err, /kontakt|napisz/i)
  })
})
