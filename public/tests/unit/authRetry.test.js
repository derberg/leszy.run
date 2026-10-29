import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getMe, getMeWithRetry, isTransientAuthError, AUTH_RETRY_DELAYS_MS } from '../../src/lib/auth.js'

const noSleep = async () => {}
const failing = (status) => async () => { const e = new Error(`status ${status}`); if (status !== undefined) e.status = status; throw e }
const counted = (fn) => { const f = async (...a) => { f.calls++; return fn(...a) }; f.calls = 0; return f }

describe('getMeWithRetry (a failed /auth-me is not „anonymous”)', () => {
  it('returns the user once a retry succeeds', async () => {
    let calls = 0
    const load = async () => { calls++; if (calls < 3) { const e = new Error('503'); e.status = 503; throw e } return { email: 'runner@test.local' } }
    const user = await getMeWithRetry({ load, delays: [1, 1, 1], sleep: noSleep })
    assert.deepEqual(user, { email: 'runner@test.local' })
    assert.equal(calls, 3)
  })
  it('a confirmed anonymous answer (null) is final, never retried', async () => {
    const load = counted(async () => null)
    assert.equal(await getMeWithRetry({ load, delays: [1], sleep: noSleep }), null)
    assert.equal(load.calls, 1)
  })
  for (const status of [404, 403, 401, 400]) {
    it(`a ${status} fails at once, with no retry`, async () => {
      const load = counted(failing(status))
      await assert.rejects(getMeWithRetry({ load, delays: [1, 1, 1], sleep: noSleep }), (e) => e.status === status)
      assert.equal(load.calls, 1)
    })
  }
  for (const status of [undefined, 500, 503, 408, 429]) {
    it(`${status === undefined ? 'a network error or timeout' : `a ${status}`} is retried`, async () => {
      const load = counted(failing(status))
      await assert.rejects(getMeWithRetry({ load, delays: [1, 1], sleep: noSleep }))
      assert.equal(load.calls, 3)
    })
  }
  it('gives up after AUTH_RETRY_DELAYS_MS.length + 1 attempts, waiting each delay in turn', async () => {
    const waits = []
    const load = counted(failing(503))
    await assert.rejects(getMeWithRetry({ load, sleep: async (ms) => { waits.push(ms) } }), /503/)
    assert.equal(load.calls, AUTH_RETRY_DELAYS_MS.length + 1)
    assert.deepEqual(waits, AUTH_RETRY_DELAYS_MS)
  })
  it('stops retrying once the answer is no longer wanted (the cache was cleared)', async () => {
    let current = true
    const load = counted(failing(503))
    await assert.rejects(getMeWithRetry({ load, delays: [1, 1, 1], sleep: async () => { current = false }, isCurrent: () => current }))
    assert.equal(load.calls, 1)
  })
  it('isTransientAuthError: no status, 5xx, 408 and 429 only', () => {
    assert.equal(isTransientAuthError(new Error('x')), true)
    for (const s of [500, 502, 503, 504, 408, 429]) assert.equal(isTransientAuthError({ status: s }), true, String(s))
    for (const s of [400, 401, 403, 404, 422]) assert.equal(isTransientAuthError({ status: s }), false, String(s))
  })
})

describe('getMe', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  it('a hung request is aborted after the timeout and fails with no status (so it is retried)', async () => {
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
    await assert.rejects(getMe({ timeoutMs: 20 }), (e) => e.status === undefined && isTransientAuthError(e))
  })
  it('a non-OK answer throws with its status', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'Profile not found' }) })
    await assert.rejects(getMe(), (e) => e.status === 404)
  })
  it('returns the user of an OK answer', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ user: { email: 'a@b.pl' } }) })
    assert.deepEqual(await getMe(), { email: 'a@b.pl' })
  })
})
