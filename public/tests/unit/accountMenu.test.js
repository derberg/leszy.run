import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { upcomingStarts, clubLinks, CLUB_STARTS_ANCHOR } from '../../src/lib/accountMenu.js'

describe('upcomingStarts', () => {
  const today = '2026-10-25'

  it('counts only starts from today on and names the nearest one', () => {
    const events = [
      { id: 1, name: 'Sylwestrowy Bieg', date: '2026-12-31', status: 'active' },
      { id: 2, name: 'Bieg Niepodległości', date: '2026-11-11', status: 'active' },
      { id: 3, name: 'Wilczy Półmaraton', date: '2026-10-17', status: 'active' },
      { id: 4, name: 'Dziś', date: '2026-10-25', status: 'active' },
    ]
    const { count, next } = upcomingStarts(events, today)
    assert.equal(count, 3)
    assert.equal(next.name, 'Dziś')
  })

  it('leaves cancelled starts out', () => {
    const events = [
      { id: 1, name: 'Odwołany', date: '2026-11-01', status: 'cancelled' },
      { id: 2, name: 'Bieg Niepodległości', date: '2026-11-11', status: 'active' },
    ]
    const { count, next } = upcomingStarts(events, today)
    assert.equal(count, 1)
    assert.equal(next.name, 'Bieg Niepodległości')
  })

  it('survives missing input', () => {
    assert.deepEqual(upcomingStarts(undefined, today), { count: 0, next: null })
    assert.deepEqual(upcomingStarts([{ id: 1, name: 'x', date: null }], today), { count: 0, next: null })
  })
})

describe('clubLinks', () => {
  it('links straight into the club area when the slug is known', () => {
    assert.deepEqual(clubLinks({ club_id: 'c1', club: 'ZATYRANI', club_slug: 'zatyrani' }), {
      hasClub: true,
      name: 'ZATYRANI',
      club: '/klub/zatyrani/panel',
      starts: `/klub/zatyrani/panel#${CLUB_STARTS_ANCHOR}`,
    })
  })

  // A user cached before auth-me returned the slug has club_id and name only.
  it('falls back to the profile club hub without a slug', () => {
    const links = clubLinks({ club_id: 'c1', club: 'ZATYRANI' })
    assert.equal(links.hasClub, true)
    assert.equal(links.club, '/profil/klub')
    assert.equal(links.starts, '/profil/klub')
  })

  it('reports no club', () => {
    assert.equal(clubLinks({ club_id: null }).hasClub, false)
    assert.equal(clubLinks(null).hasClub, false)
  })
})
