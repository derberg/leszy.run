import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createFavoritesStore } from '../../src/lib/favoritesStore.js'

// A server holding the user's stars, answering like get-favorites and
// toggle-favorite do.
function fakeServer(initial = []) {
  const starred = new Map(initial.map((e) => [e.id, e]))
  const calls = { fetch: 0, toggle: 0 }
  const pending = []
  return {
    calls,
    starred,
    fetchFavorites: async () => {
      calls.fetch++
      return { events: [...starred.values()], clubCounts: {} }
    },
    // Resolves only when release() is called, to hold a fetch in flight.
    slowFetch: () => new Promise((resolve) => {
      calls.fetch++
      const snapshot = [...starred.values()]
      pending.push(() => resolve({ events: snapshot, clubCounts: {} }))
    }),
    release: () => pending.shift()(),
    toggleFavorite: async (id) => {
      calls.toggle++
      if (starred.has(id)) { starred.delete(id); return { starred: false } }
      starred.set(id, { id, name: `Bieg ${id}` })
      return { starred: true }
    },
  }
}

function memoryStorage(value = null) {
  let stored = value
  return { read: () => stored, write: (v) => { stored = v }, clear: () => { stored = null }, peek: () => stored }
}

const ids = (store) => store.events.map((e) => e.id)

describe('favoritesStore', () => {
  it('lists an event starred after the page loaded once refreshed, without a reload', async () => {
    const server = fakeServer([{ id: 'a', name: 'Bieg a' }])
    const store = createFavoritesStore({ ...server, storage: memoryStorage() })
    await store.ensure()
    assert.deepEqual(ids(store), ['a'])

    // Starred in the kalendarz; the user then opens Obserwowane in-app.
    await store.toggle('b')
    assert.equal(store.isStarred('b'), true)
    await store.refresh()
    assert.deepEqual(ids(store), ['a', 'b'])
  })

  it('refresh asks the server even when a fresh stored copy exists', async () => {
    const server = fakeServer([{ id: 'a' }, { id: 'b' }])
    const storage = memoryStorage({ events: [{ id: 'a' }], clubCounts: {} })
    const store = createFavoritesStore({ ...server, storage })
    store.ensure()
    assert.deepEqual(ids(store), ['a'])
    assert.equal(server.calls.fetch, 0)

    await store.refresh()
    assert.deepEqual(ids(store), ['a', 'b'])
    assert.deepEqual(storage.peek().events.map((e) => e.id), ['a', 'b'])
  })

  it('shares one request between ensure and refresh made together', async () => {
    const server = fakeServer([{ id: 'a' }])
    const store = createFavoritesStore({ ...server, storage: memoryStorage() })
    await Promise.all([store.ensure(), store.refresh()])
    assert.equal(server.calls.fetch, 1)
  })

  it('does not let a fetch that started before a star click overwrite the click', async () => {
    const server = fakeServer([{ id: 'a' }])
    const store = createFavoritesStore({ ...server, fetchFavorites: server.slowFetch, storage: memoryStorage() })
    store.refresh()
    server.release()
    await new Promise((r) => setTimeout(r, 0))
    assert.deepEqual(ids(store), ['a'])

    const stale = store.refresh() // answered with the server's state before the click
    await store.toggle('a')
    server.release()
    await stale
    assert.equal(store.isStarred('a'), false)
  })

  it('reverts an optimistic star the server refused', async () => {
    const server = fakeServer()
    const store = createFavoritesStore({
      ...server,
      toggleFavorite: async () => { throw new Error('500') },
      storage: memoryStorage(),
    })
    await store.ensure()
    assert.equal(await store.toggle('x'), false)
    assert.equal(store.isStarred('x'), false)
  })

  it('reports the first ever star', async () => {
    const server = fakeServer()
    const store = createFavoritesStore({ ...server, storage: memoryStorage() })
    await store.ensure()
    assert.equal(await store.toggle('x'), true)
    assert.equal(await store.toggle('y'), false)
  })

  it('notifies subscribers when a refresh lands', async () => {
    const server = fakeServer([{ id: 'a' }])
    const store = createFavoritesStore({ ...server, storage: memoryStorage() })
    let n = 0
    store.subscribe(() => n++)
    await store.refresh()
    assert.ok(n >= 1)
  })
})
