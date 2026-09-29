import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inviteIsForCaller } from '../_shared/clubInvites.js'

// Pure — runs locally, no deployed function involved.

const caller = { email: 'Ania@Example.PL', username: 'ania_biega' }

describe('inviteIsForCaller', () => {
  it('lets anyone use a link invite — that is what a link is for', () => {
    assert.equal(inviteIsForCaller({ kind: 'link' }, caller), true)
    assert.equal(inviteIsForCaller({ kind: 'link', target_email: 'kto@inny.pl' }, caller), true)
  })

  it('accepts a direct invite addressed to the caller, whatever the casing', () => {
    assert.equal(inviteIsForCaller({ kind: 'direct', target_email: 'ania@example.pl' }, caller), true)
    assert.equal(inviteIsForCaller({ kind: 'direct', target_email: '  ANIA@EXAMPLE.PL ' }, caller), true)
    assert.equal(inviteIsForCaller({ kind: 'direct', target_username: 'ania_biega' }, caller), true)
  })

  it('refuses a direct invite addressed to somebody else', () => {
    assert.equal(inviteIsForCaller({ kind: 'direct', target_email: 'kto@inny.pl' }, caller), false)
    assert.equal(inviteIsForCaller({ kind: 'direct', target_username: 'ktos_inny' }, caller), false)
  })

  it('refuses a direct invite that names nobody rather than letting everybody in', () => {
    assert.equal(inviteIsForCaller({ kind: 'direct' }, caller), false)
    assert.equal(inviteIsForCaller({ kind: 'direct', target_email: null, target_username: null }, caller), false)
  })

  it('refuses when the caller has no identity to match', () => {
    assert.equal(inviteIsForCaller({ kind: 'direct', target_email: 'ania@example.pl' }, { email: null, username: null }), false)
  })
})
