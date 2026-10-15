import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createOutbox, classifyInsertResult, outboxKey } from '../../src/lib/checkpointOutbox.js'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v) },
  }
}

// Timers the test fires by hand, so backoff is checked without waiting.
function manualTimers() {
  const pending = []
  return {
    pending,
    schedule(fn, ms) {
      const t = { fn, ms, cancelled: false }
      pending.push(t)
      return () => {
        t.cancelled = true
        const i = pending.indexOf(t)
        if (i >= 0) pending.splice(i, 1)
      }
    },
    async fireAll() {
      const due = pending.splice(0).filter(t => !t.cancelled)
      for (const t of due) t.fn()
      await settle()
    },
  }
}

const settle = () => new Promise(r => setTimeout(r, 0))

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let seq = 0
const ids = () => `id-${++seq}`

function make({ storage = memoryStorage(), send, timers = manualTimers(), ...rest } = {}) {
  const outbox = createOutbox({
    storage,
    key: 'k',
    send,
    newId: ids,
    now: () => new Date('2026-10-17T10:00:00.000Z'),
    schedule: timers.schedule,
    timeoutMs: 8000,
    ...rest,
  })
  return { outbox, storage, timers }
}

describe('createOutbox', () => {
  it('accepts an entry immediately and persists it before any network call', () => {
    const storage = memoryStorage()
    const calls = []
    const { outbox } = make({ storage, send: (e) => { calls.push(e); return new Promise(() => {}) } })

    const entry = outbox.add(123)

    assert.equal(entry.bib, 123)
    assert.equal(entry.observedAt, '2026-10-17T10:00:00.000Z')
    const stored = JSON.parse(storage.data.k)
    assert.equal(stored.length, 1)
    assert.equal(stored[0].bib, 123)
    assert.equal(calls.length, 1, 'sending starts straight away')
  })

  it('accepts more entries while a send is still hanging', async () => {
    const first = deferred()
    const sent = []
    const { outbox } = make({ send: (e) => { sent.push(e.bib); return e.bib === 1 ? first.promise : Promise.resolve('saved') } })

    outbox.add(1)
    outbox.add(2)
    outbox.add(3)
    assert.equal(outbox.entries().length, 3)
    assert.deepEqual(sent, [1], 'one request in flight at a time')

    first.resolve('saved')
    await settle()
    assert.deepEqual(sent, [1, 2, 3])
    assert.equal(outbox.pendingCount(), 0)
  })

  it('sends in the order the volunteer typed', async () => {
    const sent = []
    const { outbox } = make({ send: async (e) => { sent.push(e.bib); return 'saved' } })
    outbox.add(7); outbox.add(8); outbox.add(9)
    await settle()
    assert.deepEqual(sent, [7, 8, 9])
  })

  it('keeps the click time as observed_at even when the send happens later', async () => {
    let clock = new Date('2026-10-17T10:00:00.000Z')
    const sent = []
    let fail = true
    const timers = manualTimers()
    const { outbox } = make({
      timers,
      now: () => clock,
      send: async (e) => { if (fail) throw new Error('Failed to fetch'); sent.push(e); return 'saved' },
    })
    outbox.add(5)
    await settle()
    clock = new Date('2026-10-17T10:05:00.000Z')
    fail = false
    await timers.fireAll()
    assert.equal(sent[0].observedAt, '2026-10-17T10:00:00.000Z')
    assert.equal(sent[0].id, outbox.entries()[0].id, 'the retry reuses the same id')
  })

  it('retries a transient failure with growing delays', async () => {
    let n = 0
    const timers = manualTimers()
    const { outbox } = make({ timers, send: async () => { n++; if (n < 4) throw new Error('Failed to fetch'); return 'saved' } })
    outbox.add(1)
    await settle()
    assert.equal(timers.pending[0].ms, 1000)
    await timers.fireAll()
    assert.equal(timers.pending[0].ms, 2000)
    await timers.fireAll()
    assert.equal(timers.pending[0].ms, 4000)
    await timers.fireAll()
    assert.equal(outbox.entries()[0].status, 'saved')
    assert.equal(outbox.entries()[0].attempts, 4)
  })

  it('caps the retry delay', async () => {
    const timers = manualTimers()
    const { outbox } = make({ timers, send: async () => { throw new Error('Failed to fetch') } })
    outbox.add(1)
    await settle()
    for (let i = 0; i < 10; i++) await timers.fireAll()
    assert.equal(timers.pending[0].ms, 15000)
  })

  it('flush() retries now instead of waiting out the backoff', async () => {
    let fail = true
    const timers = manualTimers()
    const { outbox } = make({ timers, send: async () => { if (fail) throw new Error('x'); return 'saved' } })
    outbox.add(1)
    await settle()
    fail = false
    outbox.flush()
    await settle()
    assert.equal(outbox.entries()[0].status, 'saved')
    assert.ok(timers.pending.every(t => t.cancelled), 'the pending backoff timer is cancelled')
  })

  it('aborts a hanging request after the timeout and retries it', async () => {
    const timers = manualTimers()
    let calls = 0
    const { outbox } = make({
      timers,
      send: (e, signal) => {
        calls++
        if (calls === 1) {
          return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('AbortError'))))
        }
        return Promise.resolve('saved')
      },
    })
    outbox.add(1)
    assert.equal(timers.pending[0].ms, 8000, 'timeout armed')
    await timers.fireAll() // fires the timeout → abort
    assert.equal(outbox.entries()[0].status, 'pending')
    await timers.fireAll() // fires the backoff → resend
    assert.equal(outbox.entries()[0].status, 'saved')
  })

  it('marks a duplicate as on record, not as a failure', async () => {
    const { outbox } = make({ send: async () => 'duplicate' })
    outbox.add(4)
    await settle()
    assert.equal(outbox.entries()[0].status, 'duplicate')
    assert.equal(outbox.pendingCount(), 0)
  })

  it('stops retrying a permanent failure and keeps it visible', async () => {
    const timers = manualTimers()
    const err = Object.assign(new Error('violates foreign key'), { permanent: true })
    const { outbox } = make({ timers, send: async () => { throw err } })
    outbox.add(4)
    await settle()
    assert.equal(outbox.entries()[0].status, 'failed')
    assert.equal(timers.pending.filter(t => !t.cancelled).length, 0)
    assert.equal(outbox.failedCount(), 1)
  })

  it('retry() puts a failed entry back in the queue', async () => {
    let permanent = true
    const { outbox } = make({ send: async () => { if (permanent) throw Object.assign(new Error('x'), { permanent: true }); return 'saved' } })
    const e = outbox.add(4)
    await settle()
    permanent = false
    assert.equal(outbox.retry(e.id), true)
    await settle()
    assert.equal(outbox.entries()[0].status, 'saved')
  })

  it('a later entry is not held up by a permanently failed one', async () => {
    const sent = []
    const { outbox } = make({ send: async (e) => { if (e.bib === 1) throw Object.assign(new Error('x'), { permanent: true }); sent.push(e.bib); return 'saved' } })
    outbox.add(1); outbox.add(2)
    await settle()
    assert.deepEqual(sent, [2])
  })

  it('cancel() removes a waiting entry but not one already in flight', async () => {
    const first = deferred()
    const sent = []
    const { outbox } = make({ send: (e) => { sent.push(e.bib); return e.bib === 1 ? first.promise : Promise.resolve('saved') } })
    const a = outbox.add(1)
    const b = outbox.add(2)
    assert.equal(outbox.cancel(a.id), false, 'in flight')
    assert.equal(outbox.cancel(b.id), true)
    first.resolve('saved')
    await settle()
    assert.deepEqual(sent, [1])
    assert.deepEqual(outbox.entries().map(e => e.bib), [1])
  })

  it('resumes entries left behind by a reload, including one that was in flight', async () => {
    const storage = memoryStorage({
      k: JSON.stringify([
        { id: 'a', bib: 1, observedAt: '2026-10-17T09:00:00.000Z', status: 'sending', attempts: 1 },
        { id: 'b', bib: 2, observedAt: '2026-10-17T09:00:01.000Z', status: 'pending', attempts: 0 },
        { id: 'c', bib: 3, observedAt: '2026-10-17T08:00:00.000Z', status: 'saved', attempts: 1 },
      ]),
    })
    const sent = []
    make({ storage, send: async (e) => { sent.push(e.id); return 'saved' } })
    await settle()
    assert.deepEqual(sent, ['a', 'b'])
  })

  it('ignores unreadable storage instead of crashing the page', () => {
    const storage = memoryStorage({ k: '{not json' })
    const { outbox } = make({ storage, send: async () => 'saved' })
    assert.deepEqual(outbox.entries(), [])
  })

  it('keeps working in memory when storage throws, and says so', async () => {
    const storage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } }
    const { outbox } = make({ storage, send: async () => 'saved' })
    outbox.add(1)
    assert.equal(outbox.persistent(), false)
    await settle()
    assert.equal(outbox.entries()[0].status, 'saved')
  })

  it('prunes old finished entries but never a waiting one', async () => {
    const { outbox } = make({ send: async () => 'saved', keepDone: 3 })
    for (let i = 1; i <= 6; i++) outbox.add(i)
    await settle()
    assert.deepEqual(outbox.entries().map(e => e.bib), [6, 5, 4])
  })

  it('lists newest first and notifies subscribers on every change', async () => {
    const { outbox } = make({ send: async () => 'saved' })
    let changes = 0
    const off = outbox.subscribe(() => { changes++ })
    outbox.add(1); outbox.add(2)
    await settle()
    assert.deepEqual(outbox.entries().map(e => e.bib), [2, 1])
    assert.ok(changes >= 4)
    off()
  })

  it('reports whether the last attempt reached the server', async () => {
    let fail = true
    const timers = manualTimers()
    const { outbox } = make({ timers, send: async () => { if (fail) throw new Error('x'); return 'saved' } })
    assert.equal(outbox.reachable(), true)
    outbox.add(1)
    await settle()
    assert.equal(outbox.reachable(), false)
    fail = false
    await timers.fireAll()
    assert.equal(outbox.reachable(), true)
  })
})

describe('createOutbox, review fixes', () => {
  it('cancel() refuses an entry that was already attempted, since it may be on the server', async () => {
    const timers = manualTimers()
    const { outbox } = make({ timers, send: async () => { throw new Error('Failed to fetch') } })
    const e = outbox.add(1)
    await settle()
    assert.equal(outbox.entries()[0].status, 'pending')
    assert.equal(outbox.cancel(e.id), false)
    assert.equal(outbox.entries().length, 1)
  })

  it('lengthens the timeout after consecutive timeouts and resets it once the server answers', async () => {
    const timers = manualTimers()
    let hang = true
    const { outbox } = make({
      timers,
      send: (e, signal) => hang
        ? new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('AbortError'))))
        : Promise.resolve('saved'),
    })
    outbox.add(1)
    assert.equal(timers.pending[0].ms, 8000)
    await timers.fireAll()          // timeout 1
    await timers.fireAll()          // backoff → resend
    assert.equal(timers.pending[0].ms, 16000)
    await timers.fireAll()          // timeout 2
    await timers.fireAll()
    assert.equal(timers.pending[0].ms, 30000)
    await timers.fireAll()
    await timers.fireAll()
    assert.equal(timers.pending[0].ms, 30000, 'capped')
    hang = false
    await timers.fireAll()          // timeout 3 fires, then backoff resend succeeds
    await timers.fireAll()
    assert.equal(outbox.entries()[0].status, 'saved')
    outbox.add(2)
    assert.equal(timers.pending[0].ms, 8000)
  })

  it('destroy() aborts the request in flight', () => {
    let aborted = false
    const { outbox } = make({ send: (e, signal) => { signal.addEventListener('abort', () => { aborted = true }); return new Promise(() => {}) } })
    outbox.add(1)
    outbox.destroy()
    assert.equal(aborted, true)
  })

  it('does not erase an entry another tab wrote to the same key', async () => {
    const storage = memoryStorage()
    const never = () => new Promise(() => {})
    const a = make({ storage, send: never }).outbox
    const b = make({ storage, send: never }).outbox
    a.add(1)
    b.add(2)
    const stored = JSON.parse(storage.data.k).map(e => e.bib).sort()
    assert.deepEqual(stored, [1, 2])
  })

  it('sync() adopts entries another tab added and takes its final statuses', async () => {
    const storage = memoryStorage()
    const timers = manualTimers()
    const a = make({ storage, timers, send: async () => { throw new Error('offline') } }).outbox
    const e1 = a.add(1)
    await settle()
    // Another tab delivered entry 1 and added entry 2.
    const other = JSON.parse(storage.data.k)
    other[0].status = 'saved'
    other.push({ id: 'z', bib: 2, observedAt: '2026-10-17T10:00:01.000Z', status: 'saved', attempts: 1 })
    storage.data.k = JSON.stringify(other)
    a.sync()
    const byBib = Object.fromEntries(a.entries().map(e => [e.bib, e.status]))
    assert.deepEqual(byBib, { 1: 'saved', 2: 'saved' })
    assert.equal(a.entries().find(e => e.id === e1.id).status, 'saved')
  })

  it('does not bring back an entry this tab cancelled', () => {
    const storage = memoryStorage()
    const never = () => new Promise(() => {})
    const a = make({ storage, send: never }).outbox
    a.add(1)               // in flight
    const e2 = a.add(2)    // waiting
    const stale = storage.data.k
    a.cancel(e2.id)
    storage.data.k = stale // another tab writes its older copy back
    a.sync()
    assert.deepEqual(a.entries().map(e => e.bib), [1])
  })
})

describe('createOutbox, two tabs', () => {
  it('sends a foreign entry it adopted mid-send, since the other tab may never finish it', async () => {
    const storage = memoryStorage({
      k: JSON.stringify([{ id: 'x', bib: 9, observedAt: '2026-10-17T10:00:00.000Z', status: 'pending', attempts: 0 }]),
    })
    const sent = []
    const a = make({ storage, send: async (e) => { sent.push(e.id); return 'saved' } }).outbox
    await settle()
    sent.length = 0
    // Tab B adds an entry and is caught sending it.
    const raw = JSON.parse(storage.data.k)
    raw.push({ id: 'y', bib: 10, observedAt: '2026-10-17T10:00:05.000Z', status: 'sending', attempts: 1 })
    storage.data.k = JSON.stringify(raw)
    a.sync()
    await settle()
    assert.deepEqual(sent, ['y'])
    assert.equal(a.pendingCount(), 0)
  })

  it('a cancel in one tab stops the other tab from sending the entry', async () => {
    const storage = memoryStorage()
    const first = deferred()
    const sentB = []
    const timers = manualTimers()
    const a = make({ storage, timers, send: () => first.promise }).outbox
    a.add(1)              // in flight in A
    const e2 = a.add(2)   // waiting in A
    const b = make({ storage, timers, send: (e) => { sentB.push(e.bib); return new Promise(() => {}) } }).outbox
    // B loaded both; it is now sending 1 and has 2 waiting.
    assert.equal(a.cancel(e2.id), true)
    b.sync()
    first.resolve('saved')
    await settle()
    assert.deepEqual(sentB, [1])
    assert.deepEqual(b.entries().map(e => e.bib), [1])
    assert.deepEqual(a.entries().map(e => e.bib), [1])
  })

  it('a failed entry takes a delivery reported by the other tab', () => {
    const storage = memoryStorage()
    const a = make({ storage, send: async () => { throw Object.assign(new Error('x'), { permanent: true }) } }).outbox
    const e = a.add(3)
    return settle().then(() => {
      const raw = JSON.parse(storage.data.k)
      raw[0].status = 'duplicate'
      storage.data.k = JSON.stringify(raw)
      a.sync()
      assert.equal(a.entries().find(x => x.id === e.id).status, 'duplicate')
      assert.equal(a.failedCount(), 0)
    })
  })
})

describe('classifyInsertResult', () => {
  it('a returned row is saved', () => {
    assert.equal(classifyInsertResult({ data: [{ id: 'x' }], error: null }), 'saved')
  })
  it('no row back means the trigger dropped it: already on record', () => {
    assert.equal(classifyInsertResult({ data: [], error: null }), 'duplicate')
  })
  it('a unique violation means an earlier attempt already landed', () => {
    assert.equal(classifyInsertResult({ data: null, error: { code: '23505', message: 'dup' } }), 'duplicate')
  })
  it('a network error is transient', () => {
    assert.throws(
      () => classifyInsertResult({ data: null, error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 }),
      (e) => e.permanent === false,
    )
  })
  it('a gateway 5xx is transient', () => {
    assert.throws(
      () => classifyInsertResult({ data: null, error: { code: '', message: 'Bad gateway' }, status: 502 }),
      (e) => e.permanent === false,
    )
  })
  it('a statement timeout is transient', () => {
    assert.throws(
      () => classifyInsertResult({ data: null, error: { code: '57014', message: 'canceling statement' }, status: 500 }),
      (e) => e.permanent === false,
    )
  })
  it('PostgREST connection and schema-cache errors are transient', () => {
    for (const [code, status] of [['PGRST000', 503], ['PGRST001', 503], ['PGRST002', 503], ['PGRST003', 504]]) {
      assert.throws(
        () => classifyInsertResult({ data: null, error: { code, message: 'x' }, status }),
        (e) => e.permanent === false,
        code,
      )
    }
  })
  it('any 5xx or 429 is transient whatever the code', () => {
    for (const status of [500, 502, 503, 429]) {
      assert.throws(
        () => classifyInsertResult({ data: null, error: { code: 'XX000', message: 'x' }, status }),
        (e) => e.permanent === false,
        String(status),
      )
    }
  })
  it('a foreign key or RLS violation is permanent', () => {
    for (const code of ['23503', '42501', '22P02', 'PGRST204']) {
      assert.throws(
        () => classifyInsertResult({ data: null, error: { code, message: 'no' }, status: 400 }),
        (e) => e.permanent === true,
        code,
      )
    }
  })
})

describe('outboxKey', () => {
  it('is scoped to the checkpoint', () => {
    assert.notEqual(outboxKey('a'), outboxKey('b'))
  })
})
