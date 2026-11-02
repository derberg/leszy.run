import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inviteIsForCaller, inviteState, invitesToOffer } from '../_shared/clubInvites.js'

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

describe('inviteState', () => {
  const now = new Date('2026-10-25T12:00:00Z')

  it('calls a fresh invite valid', () => {
    assert.equal(inviteState({ revoked: false, expires_at: null, max_uses: null, uses: 3 }, now), 'valid')
    assert.equal(inviteState({ revoked: false, expires_at: '2026-11-01T00:00:00Z', max_uses: 5, uses: 4 }, now), 'valid')
  })

  it('names why an invite is dead, revocation first', () => {
    assert.equal(inviteState({ revoked: true, expires_at: '2026-10-01T00:00:00Z', max_uses: 1, uses: 1 }, now), 'revoked')
    assert.equal(inviteState({ revoked: false, expires_at: '2026-10-01T00:00:00Z', max_uses: 1, uses: 1 }, now), 'expired')
    assert.equal(inviteState({ revoked: false, expires_at: null, max_uses: 1, uses: 1 }, now), 'exhausted')
  })
})

describe('invitesToOffer', () => {
  const now = new Date('2026-10-25T12:00:00Z')
  const live = { id: 'a', club_id: 'c1', revoked: false, expires_at: '2026-11-24T00:00:00Z', max_uses: 1, uses: 0 }

  it('offers a live invite to a club the caller is not in', () => {
    assert.deepEqual(invitesToOffer([live], [], now).map((i) => i.id), ['a'])
  })

  it('drops a direct invite that was already accepted', () => {
    // Its single use is spent, so accept-invite answers "wyczerpane" — the
    // profile used to keep offering it to the person who had just joined.
    assert.deepEqual(invitesToOffer([{ ...live, uses: 1 }], [], now), [])
  })

  it('drops an invite to a club the caller already belongs to', () => {
    assert.deepEqual(invitesToOffer([live], ['c1'], now), [])
  })

  it('drops revoked and expired invites', () => {
    assert.deepEqual(invitesToOffer([
      { ...live, revoked: true },
      { ...live, expires_at: '2026-10-01T00:00:00Z' },
    ], [], now), [])
  })
})
