import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateFollowedEvents, sharingMemberIds } from '../_shared/clubFollowers.js'

// Pure aggregation behind get-club's followedEvents — runs locally, unlike the
// suites that call a deployed function over HTTP.

const TODAY = '2026-10-01'

function member(id, { status = 'active', favorites } = {}) {
  return {
    user_id: id,
    status,
    profiles: { privacy_settings: favorites === undefined ? {} : { favorites } },
  }
}

function fav(userId, event) {
  return { user_id: userId, event_id: event.id, calendar_events: event }
}

const bieg = { id: 'e1', name: 'Bieg Zatyrany', date: '2026-10-12', status: 'active' }
const marsz = { id: 'e2', name: 'Marsz z kijami', date: '2026-11-03', status: 'active' }

describe('sharingMemberIds', () => {
  it('keeps active members who have not opted out of sharing favorites', () => {
    const rows = [member('a'), member('b', { favorites: true })]
    assert.deepEqual(sharingMemberIds(rows), ['a', 'b'])
  })

  it('drops members who opted out, and pending members', () => {
    const rows = [member('a'), member('b', { favorites: false }), member('c', { status: 'pending' })]
    assert.deepEqual(sharingMemberIds(rows), ['a'])
  })
})

describe('aggregateFollowedEvents', () => {
  it('reports who follows each event, not just how many', () => {
    const rows = [member('a'), member('b')]
    const out = aggregateFollowedEvents(rows, [fav('a', bieg), fav('b', bieg)], TODAY)
    assert.equal(out.length, 1)
    assert.equal(out[0].count, 2)
    assert.deepEqual(out[0].followers, ['a', 'b'])
  })

  it('leaves out a member who stopped sharing what they follow', () => {
    const rows = [member('a'), member('b', { favorites: false })]
    const out = aggregateFollowedEvents(rows, [fav('a', bieg), fav('b', bieg)], TODAY)
    assert.equal(out[0].count, 1)
    assert.deepEqual(out[0].followers, ['a'])
  })

  it('sorts by date and skips events that already happened', () => {
    const rows = [member('a')]
    const past = { id: 'e0', name: 'Bieg Wrześniowy', date: '2026-09-20', status: 'active' }
    const out = aggregateFollowedEvents(rows, [fav('a', marsz), fav('a', bieg), fav('a', past)], TODAY)
    assert.deepEqual(out.map((e) => e.event.id), ['e1', 'e2'])
  })

  it('skips events that are neither active nor cancelled', () => {
    const rows = [member('a')]
    const pending = { id: 'e3', name: 'Bieg Niezatwierdzony', date: '2026-10-20', status: 'pending' }
    const out = aggregateFollowedEvents(rows, [fav('a', pending)], TODAY)
    assert.deepEqual(out, [])
  })

  it('counts a follower once per event even if the row repeats', () => {
    const rows = [member('a')]
    const out = aggregateFollowedEvents(rows, [fav('a', bieg), fav('a', bieg)], TODAY)
    assert.equal(out[0].count, 1)
    assert.deepEqual(out[0].followers, ['a'])
  })
})
