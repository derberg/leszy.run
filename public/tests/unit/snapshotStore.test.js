import { describe, it } from 'node:test'
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
    const fetch = fakeFetch([{ generatedAt: 't1' }])
    let a = 0, b = 0
    const offA = subscribe('ev-1', () => a++, fetch)
    const offB = subscribe('ev-1', () => b++, fetch)
    await tick()
    assert.deepEqual(fetch.calls, ['/api/results?event=ev-1'])
    assert.equal(getSnapshot('ev-1').generatedAt, 't1')
    assert.equal(a, 1)
    assert.equal(b, 1)
    offA()
    offB()
  })

  it('forgets the event and its snapshot once the last listener leaves', async () => {
    const fetch = fakeFetch([{ generatedAt: 't1' }])
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
  it('refuses a request without a valid event id and keeps the error out of the CDN', async () => {
    for (const url of ['/api/results', '/api/results?event=1;drop', '/?event=abc']) {
      const res = fakeRes()
      await handler({ url }, res)
      assert.equal(res.statusCode, 400)
      assert.equal(res.headers['Cache-Control'], 'no-store')
      assert.equal(res.headers['Vercel-CDN-Cache-Control'], undefined)
    }
  })
})
