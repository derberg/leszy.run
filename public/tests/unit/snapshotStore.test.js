import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { subscribe, getSnapshot } from '../../src/lib/snapshotStore.js'
import handler from '../../api/results.js'

const tick = () => new Promise(r => setTimeout(r, 0))

function fakeFetch(bodies) {
  const calls = []
  const fn = async (url) => {
    calls.push(url)
    const body = bodies.shift()
    if (!body) return { ok: false }
    return { ok: true, json: async () => body }
  }
  fn.calls = calls
  return fn
}

describe('snapshotStore', () => {
  it('fetches once for all listeners of an event and notifies each of them', async () => {
    const fetch = fakeFetch([{ version: 'v1' }])
    let a = 0, b = 0
    const offA = subscribe('ev-1', () => a++, fetch)
    const offB = subscribe('ev-1', () => b++, fetch)
    await tick()
    assert.deepEqual(fetch.calls, ['/api/results?event=ev-1'])
    assert.equal(getSnapshot('ev-1').version, 'v1')
    assert.equal(a, 1)
    assert.equal(b, 1)
    offA()
    offB()
  })

  it('skips a poll that brings the same version, and polls every 60 s once no run is live', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)) }
    try {
      const fetch = fakeFetch([{ version: 'v1', live: true }, { version: 'v1', live: true }, { version: 'v2', live: false }, { version: 'v3', live: false }])
      let notified = 0
      const off = subscribe('ev-4', () => notified++, fetch)
      await flush()
      assert.equal(notified, 1)
      mock.timers.tick(5_000); await flush()
      assert.equal(fetch.calls.length, 2)
      assert.equal(notified, 1)
      mock.timers.tick(5_000); await flush()
      assert.equal(getSnapshot('ev-4').version, 'v2')
      assert.equal(notified, 2)
      mock.timers.tick(5_000); await flush()
      assert.equal(fetch.calls.length, 3)
      mock.timers.tick(55_000); await flush()
      assert.equal(fetch.calls.length, 4)
      off()
    } finally {
      mock.timers.reset()
    }
  })

  it('waits 60 s for the first poll when the first answer says no run is live', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)) }
    try {
      const fetch = fakeFetch([{ version: 'v1', live: false }, { version: 'v1', live: false }])
      const off = subscribe('ev-5', () => {}, fetch)
      await flush()
      mock.timers.tick(5_000); await flush()
      assert.equal(fetch.calls.length, 1)
      mock.timers.tick(55_000); await flush()
      assert.equal(fetch.calls.length, 2)
      off()
    } finally {
      mock.timers.reset()
    }
  })

  it('forgets the event and its snapshot once the last listener leaves', async () => {
    const fetch = fakeFetch([{ version: 'v1' }])
    const off = subscribe('ev-2', () => {}, fetch)
    await tick()
    off()
    assert.equal(getSnapshot('ev-2'), null)
  })

  it('keeps nothing from a failed fetch', async () => {
    const fetch = fakeFetch([])
    let notified = 0
    const off = subscribe('ev-3', () => notified++, fetch)
    await tick()
    assert.equal(getSnapshot('ev-3'), null)
    assert.equal(notified, 0)
    off()
  })
})

function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(b) { this.body = b },
  }
}

describe('api/results', () => {
  it('refuses anything but one lowercase event id, and keeps the error out of the CDN', async () => {
    const id = 'fab0de56-2645-4c24-ae52-6342f0c799b4'
    for (const url of ['/api/results', '/api/results?event=1;drop', '/?event=abc',
      `/?event=${id}&x=1`, `/?event=${id.toUpperCase()}`, `/?event=${id}&event=${id}`]) {
      const res = fakeRes()
      await handler({ url }, res)
      assert.equal(res.statusCode, 400)
      assert.equal(res.headers['Cache-Control'], 'no-store')
      assert.equal(res.headers['Vercel-CDN-Cache-Control'], undefined)
    }
  })
})
