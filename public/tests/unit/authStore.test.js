import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAuthStore } from '../../src/lib/authStore.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function storeWith(calls, { cache = null } = {}) {
  return createAuthStore({
    fetchUser: (o) => { const d = deferred(); calls.push({ ...d, ...o }); return d.promise },
    readCache: () => cache,
    clearCache: () => {},
    revalidateMs: 1000,
  })
}

describe('createAuthStore', () => {
  it('one call in flight is shared by every waiter', async () => {
    const calls = []
    const store = storeWith(calls)
    const a = store.load()
    const b = store.load()
    assert.equal(calls.length, 1)
    calls[0].resolve({ email: 'runner@test.local' })
    assert.deepEqual(await a, { email: 'runner@test.local' })
    assert.deepEqual(await b, { email: 'runner@test.local' })
    assert.deepEqual(store.current(), { email: 'runner@test.local' })
  })

  it('a call still running when the cache is cleared never overwrites what came after (login meanwhile)', async () => {
    const calls = []
    const store = storeWith(calls)
    const before = store.load() // started as a visitor
    store.clear() // login: the session cookie now exists
    const after = store.load()
    assert.equal(calls.length, 2)
    assert.equal(calls[0].isCurrent(), false)
    assert.equal(calls[1].isCurrent(), true)

    calls[1].resolve({ email: 'runner@test.local' })
    assert.deepEqual(await after, { email: 'runner@test.local' })
    calls[0].resolve(null) // the old, pre-login answer lands last
    assert.deepEqual(await before, { email: 'runner@test.local' }, 'the old waiter gets the new answer')
    assert.deepEqual(store.current(), { email: 'runner@test.local' })
    // and the old call did not drop the store's call in flight or start another
    assert.equal(calls.length, 2)
  })

  it('a failed call settles on what was known before', async () => {
    const calls = []
    const store = storeWith(calls, { cache: { user: { email: 'old@x.pl' }, ts: 0 } })
    const p = store.load()
    calls[0].reject(new Error('down'))
    assert.deepEqual(await p, { email: 'old@x.pl' })
  })

  it('needsCheck: a fresh cache with a known user skips the call', () => {
    const fresh = createAuthStore({ fetchUser: async () => null, readCache: () => ({ user: null, ts: 1000 }), clearCache: () => {}, revalidateMs: 100, now: () => 1050 })
    assert.equal(fresh.needsCheck(), false)
    const stale = createAuthStore({ fetchUser: async () => null, readCache: () => ({ user: null, ts: 1000 }), clearCache: () => {}, revalidateMs: 100, now: () => 1200 })
    assert.equal(stale.needsCheck(), true)
    const none = createAuthStore({ fetchUser: async () => null, readCache: () => null, clearCache: () => {}, revalidateMs: 100 })
    assert.equal(none.needsCheck(), true)
  })
})
