import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { excludedParticipants, nearFinishRunners, nearFinishTabVisible } from '../../src/lib/nearFinish.js'

const participants = [
  { id: 'p1', bib_number: 1, first_name: 'Anna', last_name: 'A', category_id: 'hm' },
  { id: 'p2', bib_number: 2, first_name: 'Bartek', last_name: 'B', category_id: 'hm' },
  { id: 'p3', bib_number: 3, first_name: 'Celina', last_name: 'C', category_id: 'cc' },
  { id: 'p4', bib_number: 4, first_name: 'Darek', last_name: 'D', category_id: 'cc' },
]
const obs = (id, bib, pid, t) => ({ id, bib_number: bib, participant_id: pid, observed_at: `2026-10-18T10:${t}:00Z` })
const observations = [
  obs('o1', 1, 'p1', '01'),
  obs('o2', 2, 'p2', '02'),
  obs('o3', 3, 'p3', '03'),
  obs('o4', 4, null, '04'),
  obs('o5', 1, 'p1', '05'), // second pass of the same runner
]
const catMap = { hm: 'Półmaraton 21km', cc: 'Canicross 21km' }
const bibs = (rows) => rows.map(r => r.bibNumber)

describe('excludedParticipants', () => {
  it('separates DNS from finished and keeps DNF/DSQ on the list', () => {
    const { dns, finished } = excludedParticipants([
      { participant_id: 'p1', status: 'finished', finish_time: '2026-10-18T10:10:00Z' },
      { participant_id: 'p2', status: 'dns', finish_time: null },
      { participant_id: 'p3', status: 'dnf', finish_time: null },
      { participant_id: 'p4', status: 'started', finish_time: null },
    ])
    assert.deepEqual([...dns], ['p2'])
    assert.deepEqual([...finished], ['p1'])
  })

  it('treats a finish time as finished whatever the status says', () => {
    const { finished } = excludedParticipants([{ participant_id: 'p1', status: 'started', finish_time: '2026-10-18T10:10:00Z' }])
    assert.ok(finished.has('p1'))
  })
})

describe('nearFinishRunners', () => {
  it('lists everyone seen and not finished, once each, newest first', () => {
    const rows = nearFinishRunners({ observations, participants, excluded: excludedParticipants([]), catMap })
    assert.deepEqual(bibs(rows), [4, 3, 2, 1])
    assert.equal(rows.find(r => r.bibNumber === 1).observedAt, '2026-10-18T10:01:00Z')
  })

  it('drops a runner once they cross the finish', () => {
    const excluded = excludedParticipants([{ participant_id: 'p3', status: 'finished', finish_time: '2026-10-18T10:09:00Z' }])
    const rows = nearFinishRunners({ observations, participants, excluded, catMap })
    assert.deepEqual(bibs(rows), [4, 2, 1])
  })

  it('drops a finished runner matched by bib when the observation has no participant id', () => {
    const excluded = excludedParticipants([{ participant_id: 'p4', status: 'finished', finish_time: '2026-10-18T10:09:00Z' }])
    const rows = nearFinishRunners({ observations, participants, excluded, catMap })
    assert.deepEqual(bibs(rows), [3, 2, 1])
  })

  it('still drops DNS runners', () => {
    const excluded = excludedParticipants([{ participant_id: 'p2', status: 'dns', finish_time: null }])
    const rows = nearFinishRunners({ observations, participants, excluded, catMap })
    assert.deepEqual(bibs(rows), [4, 3, 1])
  })
})

describe('nearFinishTabVisible', () => {
  it('is hidden before any run starts', () => {
    assert.equal(nearFinishTabVisible([{ status: 'pending' }], 'cp'), false)
    assert.equal(nearFinishTabVisible([], 'cp'), false)
    assert.equal(nearFinishTabVisible(null, 'cp'), false)
  })
  it('is shown while any run is active', () => {
    assert.equal(nearFinishTabVisible([{ status: 'finished' }, { status: 'active' }], 'cp'), true)
  })
  it('is hidden once every run is over, and without a near-finish checkpoint', () => {
    assert.equal(nearFinishTabVisible([{ status: 'finished' }, { status: 'cancelled' }], 'cp'), false)
    assert.equal(nearFinishTabVisible([{ status: 'active' }], null), false)
  })
})
