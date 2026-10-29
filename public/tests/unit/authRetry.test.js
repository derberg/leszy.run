import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getMeWithRetry } from '../../src/lib/auth.js'

const noSleep = async () => {}

describe('getMeWithRetry (a failed /auth-me is not „anonymous”)', () => {
  it('returns the user once a retry succeeds', async () => {
    let calls = 0
    const load = async () => { calls++; if (calls < 3) throw new Error('503'); return { email: 'runner@test.local' } }
    const user = await getMeWithRetry({ load, delays: [1, 1, 1], sleep: noSleep })
    assert.deepEqual(user, { email: 'runner@test.local' })
    assert.equal(calls, 3)
  })
  it('a confirmed anonymous answer (null) is final, never retried', async () => {
    let calls = 0
    assert.equal(await getMeWithRetry({ load: async () => { calls++; return null }, delays: [1], sleep: noSleep }), null)
    assert.equal(calls, 1)
  })
  it('rejects after the last attempt, waiting the given delays in between', async () => {
    const waits = []
    let calls = 0
    await assert.rejects(getMeWithRetry({
      load: async () => { calls++; throw new Error('down') }, delays: [10, 20], sleep: async (ms) => { waits.push(ms) },
    }), /down/)
    assert.equal(calls, 3)
    assert.deepEqual(waits, [10, 20])
  })
})
