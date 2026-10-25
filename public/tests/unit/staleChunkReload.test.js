import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { installStaleChunkReload, RELOAD_GUARD_MS } from '../../src/lib/staleChunkReload.js'

function fakeWindow() {
  const handlers = []
  const win = {
    reloads: 0,
    addEventListener: (type, fn) => { if (type === 'vite:preloadError') handlers.push(fn) },
    location: { reload: () => { win.reloads++ } },
    fail: () => {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      handlers.forEach((fn) => fn(event))
      return event
    },
  }
  return win
}

function memoryStorage() {
  const m = new Map()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }
}

describe('installStaleChunkReload', () => {
  it('reloads once when a lazy page chunk is missing after a deploy', () => {
    const win = fakeWindow()
    installStaleChunkReload(win, memoryStorage(), () => 1_000_000)
    const event = win.fail()
    assert.equal(win.reloads, 1)
    assert.equal(event.defaultPrevented, true)
  })

  it('does not reload in a loop when the chunk is still missing after the reload', () => {
    const win = fakeWindow()
    const storage = memoryStorage()
    let t = 1_000_000
    installStaleChunkReload(win, storage, () => t)
    win.fail()
    t += 2_000
    const event = win.fail()
    assert.equal(win.reloads, 1)
    assert.equal(event.defaultPrevented, false)
  })

  it('reloads again for a later deploy', () => {
    const win = fakeWindow()
    let t = 1_000_000
    installStaleChunkReload(win, memoryStorage(), () => t)
    win.fail()
    t += RELOAD_GUARD_MS + 1
    win.fail()
    assert.equal(win.reloads, 2)
  })

  it('leaves the error alone when storage is blocked, rather than risk a loop', () => {
    const win = fakeWindow()
    const blocked = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    installStaleChunkReload(win, blocked, () => 1_000_000)
    win.fail()
    assert.equal(win.reloads, 0)
  })
})
