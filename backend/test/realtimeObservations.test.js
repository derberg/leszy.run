import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyRemoteObservation } from '../src/sync/realtimeObservations.js'

const remote = { id: 'obs-1', checkpoint_id: 'cp-1', bib_number: 902, observed_at: '2026-11-04T17:56:00Z', source: 'manual' }

function fakeIo({ checkpoints = { 'cp-1': 'ev-1' }, participants = { 'ev-1:902': 'p-1' }, existing = new Set(), failInsert } = {}) {
  const calls = { inserted: [], updated: [], broadcast: [], logs: [] }
  return {
    calls,
    checkpointEventId: async (id) => checkpoints[id] ?? null,
    participantIdFor: async (eventId, bib) => participants[`${eventId}:${bib}`] ?? null,
    insert: async (row) => {
      if (failInsert) throw failInsert
      calls.inserted.push(row)
    },
    update: async (row) => {
      if (!existing.has(row.id)) return false
      calls.updated.push(row)
      return true
    },
    broadcast: (payload) => calls.broadcast.push(payload),
    log: (msg) => calls.logs.push(msg),
  }
}

describe('applyRemoteObservation', () => {
  it('stores and broadcasts an observation whose checkpoint is on this host', async () => {
    const io = fakeIo()
    await applyRemoteObservation(remote, 'INSERT', io)
    assert.equal(io.calls.inserted.length, 1)
    assert.equal(io.calls.inserted[0].participantId, 'p-1')
    assert.equal(io.calls.broadcast.length, 1)
  })

  it('skips an observation whose checkpoint this host never pulled (test data, a draft event)', async () => {
    // The release smoke test writes bib 902 to a throwaway [e2e-test] checkpoint
    // that configSync refuses; inserting it broke the FK and killed the backend.
    const io = fakeIo({ checkpoints: {} })
    await applyRemoteObservation(remote, 'INSERT', io)
    await applyRemoteObservation(remote, 'UPDATE', io)
    assert.deepEqual(io.calls.inserted, [])
    assert.deepEqual(io.calls.updated, [])
    assert.deepEqual(io.calls.broadcast, [])
  })

  it('updates an existing row on UPDATE, and inserts it when this host missed the INSERT', async () => {
    const seen = fakeIo({ existing: new Set(['obs-1']) })
    await applyRemoteObservation(remote, 'UPDATE', seen)
    assert.equal(seen.calls.updated.length, 1)
    assert.equal(seen.calls.inserted.length, 0)

    const missed = fakeIo()
    await applyRemoteObservation(remote, 'UPDATE', missed)
    assert.equal(missed.calls.inserted.length, 1)
  })

  it('logs a database error instead of throwing, so the process stays up', async () => {
    const io = fakeIo({ failInsert: new Error('connection reset') })
    await assert.doesNotReject(applyRemoteObservation(remote, 'INSERT', io))
    assert.match(io.calls.logs.join('\n'), /connection reset/)
    assert.equal(io.calls.broadcast.length, 0)
  })
})
