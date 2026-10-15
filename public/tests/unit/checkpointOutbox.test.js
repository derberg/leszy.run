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
