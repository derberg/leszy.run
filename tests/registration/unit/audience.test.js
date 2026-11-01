import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAudience } from '../../../supabase/functions/_shared/registration/audience.js'

const adult = (id, email, over = {}) => ({ id, status: 'confirmed', category_id: 'c1', email, team_id: null, ...over })
const minor = (id, guardian_email, over = {}) => adult(id, null, { guardian_name: 'Ewa', guardian_email, ...over })
const ALL = { status: 'all', teams: 'members' }

describe('resolveAudience (O-05)', () => {
  it('a family of four on one address plus two children is one e-mail', () => {
    const rows = [
      adult('a', 'rodzina@example.pl'), adult('b', ' Rodzina@Example.pl '), adult('c', 'RODZINA@example.pl'), adult('d', 'rodzina@example.pl'),
      minor('e', 'rodzina@example.pl'), minor('f', 'Rodzina@example.pl '),
    ]
    assert.deepEqual(resolveAudience(rows, ALL), [
      { email: 'rodzina@example.pl', registrationIds: ['a', 'b', 'c', 'd', 'e', 'f'] },
    ])
  })

  it('a minor is reached through the guardian only, never through a stored own address', () => {
    assert.deepEqual(resolveAudience([minor('m', 'ewa@example.pl', { email: 'dziecko@example.pl' })], ALL),
      [{ email: 'ewa@example.pl', registrationIds: ['m'] }])
  })

  it('a minor whose guardian address is gone, or an erased adult, is nobody to write to', () => {
    assert.deepEqual(resolveAudience([
      minor('m', null, { guardian_profile_id: 'p', guardian_name: 'Usunięte konto', email: 'dziecko@example.pl' }),
      adult('x', null), adult('y', '   '),
    ], ALL), [])
  })

  it('takes live rows only: expired, cancelled and transferred get nothing', () => {
    const rows = [
      adult('a', 'a@example.pl'), adult('b', 'b@example.pl', { status: 'pending_payment' }),
      adult('c', 'c@example.pl', { status: 'expired' }), adult('d', 'd@example.pl', { status: 'cancelled' }),
      adult('e', 'e@example.pl', { status: 'transferred_out' }),
    ]
    assert.deepEqual(resolveAudience(rows, ALL).map((r) => r.email), ['a@example.pl', 'b@example.pl'])
  })

  it('narrows by status', () => {
    const rows = [adult('a', 'a@example.pl'), adult('b', 'b@example.pl', { status: 'pending_payment' })]
    assert.deepEqual(resolveAudience(rows, { status: 'confirmed', teams: 'members' }).map((r) => r.email), ['a@example.pl'])
    assert.deepEqual(resolveAudience(rows, { status: 'awaiting', teams: 'members' }).map((r) => r.email), ['b@example.pl'])
  })

  it('narrows by competition, an empty choice meaning every competition', () => {
    const rows = [adult('a', 'a@example.pl'), adult('b', 'b@example.pl', { category_id: 'c2' })]
    assert.deepEqual(resolveAudience(rows, { ...ALL, categoryIds: ['c2'] }).map((r) => r.email), ['b@example.pl'])
    assert.equal(resolveAudience(rows, { ...ALL, categoryIds: [] }).length, 2)
  })

  it('captains only drops the other team members and leaves individual entries alone', () => {
    const rows = [
      adult('cap', 'cap@example.pl', { team_id: 't1', is_captain: true }),
      adult('mem', 'mem@example.pl', { team_id: 't1', is_captain: false }),
      minor('kid', 'ewa@example.pl', { team_id: 't1' }),
      adult('solo', 'solo@example.pl'),
    ]
    assert.deepEqual(resolveAudience(rows, { status: 'all', teams: 'captains' }).map((r) => r.email), ['cap@example.pl', 'solo@example.pl'])
    assert.equal(resolveAudience(rows, ALL).length, 4)
  })

  it('refuses a filter it does not know rather than mailing everybody', () => {
    assert.throws(() => resolveAudience([], { status: 'everyone', teams: 'members' }), /invalid_status/)
    assert.throws(() => resolveAudience([], { status: 'all', teams: 'nobody' }), /invalid_teams/)
  })
})
