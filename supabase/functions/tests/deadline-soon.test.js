import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deadlineSoonFor, DEADLINE_WINDOW_DAYS } from '../_shared/deadlineSoon.js'

const TODAY = '2026-09-29'
const ev = (over = {}) => ({ id: 'e1', name: 'Bieg', date: '2026-10-20', status: 'active', registration_deadline: '2026-10-02', ...over })

describe('deadlineSoonFor', () => {
  it('raises one for a race whose registration closes within the window', () => {
    const out = deadlineSoonFor(ev(), TODAY)
    assert.equal(out.type, 'deadline_soon')
    assert.equal(out.event_id, 'e1')
  })

  it('dates it from the deadline, not from now, so it is stable between runs', () => {
    const out = deadlineSoonFor(ev({ registration_deadline: '2026-10-02' }), TODAY)
    // 7 days before the deadline: the moment it entered the window.
    assert.equal(out.created_at.slice(0, 10), '2026-09-25')
    assert.equal(DEADLINE_WINDOW_DAYS, 7)
  })

  it('says nothing when the deadline is further out than the window', () => {
    assert.equal(deadlineSoonFor(ev({ registration_deadline: '2026-11-30' }), TODAY), null)
  })

  it('says nothing once registration has closed', () => {
    assert.equal(deadlineSoonFor(ev({ registration_deadline: '2026-09-28' }), TODAY), null)
  })

  it('says nothing about a race that has already been run', () => {
    assert.equal(deadlineSoonFor(ev({ date: '2026-09-20' }), TODAY), null)
  })

  it('says nothing about an event that is not published', () => {
    assert.equal(deadlineSoonFor(ev({ status: 'rejected' }), TODAY), null)
    assert.equal(deadlineSoonFor(ev({ status: 'pending' }), TODAY), null)
  })

  it('says nothing when there is no deadline to speak of', () => {
    assert.equal(deadlineSoonFor(ev({ registration_deadline: null }), TODAY), null)
    assert.equal(deadlineSoonFor(null, TODAY), null)
  })
})
