import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyResultChange, canApplyResultChange, coalesce } from '../../src/lib/liveResults.js'

const anna = { id: 'p1', firstName: 'Anna' }
const pMap = { p1: anna }
const row = { id: 'r1', race_run_id: 'run', participant_id: 'p1', start_time: 's', finish_time: null, duration_ms: null, gun_duration_ms: null, status: 'started' }

describe('applyResultChange', () => {
  const enriched = [{ ...row, participantId: 'p1', startTime: 's', finishTime: null, durationMs: null, gunDurationMs: null, participant: anna }]

  it('patches a known result in place from the realtime row', () => {
    const next = applyResultChange(enriched, { eventType: 'UPDATE', new: { ...row, finish_time: 'f', duration_ms: 10, status: 'finished' } }, pMap)
    assert.equal(next.length, 1)
    assert.equal(next[0].finishTime, 'f')
    assert.equal(next[0].durationMs, 10)
    assert.equal(next[0].status, 'finished')
    assert.equal(next[0].participant, anna)
  })

  it('adds a new result for a runner the page already knows', () => {
    const next = applyResultChange([], { eventType: 'INSERT', new: row }, pMap)
    assert.equal(next.length, 1)
    assert.equal(next[0].participant, anna)
  })

  it('returns null for a runner the page has not loaded, so the caller reloads', () => {
    assert.equal(applyResultChange(enriched, { eventType: 'INSERT', new: { ...row, id: 'r2', participant_id: 'p9' } }, pMap), null)
  })

  it('drops a deleted result', () => {
    assert.deepEqual(applyResultChange(enriched, { eventType: 'DELETE', old: { id: 'r1' } }, pMap), [])
  })

  it('returns null when the payload carries no row', () => {
    assert.equal(applyResultChange(enriched, { eventType: 'UPDATE', new: {} }, pMap), null)
  })
})

describe('canApplyResultChange', () => {
  it('agrees with applyResultChange', () => {
    const cases = [
      { eventType: 'UPDATE', new: row },
      { eventType: 'INSERT', new: { ...row, participant_id: 'p9' } },
      { eventType: 'UPDATE', new: {} },
      { eventType: 'DELETE', old: { id: 'r1' } },
      { eventType: 'DELETE', old: {} },
    ]
    for (const c of cases) assert.equal(canApplyResultChange(c, pMap), applyResultChange([], c, pMap) !== null)
  })
})

describe('coalesce', () => {
  it('runs once for a burst of triggers', async () => {
    let runs = 0
    const c = coalesce(() => { runs++ }, 20, 0)
    c.trigger(); c.trigger(); c.trigger()
    await new Promise(r => setTimeout(r, 50))
    assert.equal(runs, 1)
    c.trigger()
    await new Promise(r => setTimeout(r, 50))
    assert.equal(runs, 2)
  })

  it('cancel stops a pending run', async () => {
    let runs = 0
    const c = coalesce(() => { runs++ }, 20, 0)
    c.trigger(); c.cancel()
    await new Promise(r => setTimeout(r, 50))
    assert.equal(runs, 0)
  })
})
