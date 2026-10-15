// Outbox for the volunteer checkpoint page.
//
// A volunteer types a bib and taps "Wyślij". The page used to wait for Supabase
// before it would accept the next one, and on a weak signal that wait could
// last tens of seconds while the next runner went past. Now the tap only writes
// the entry to localStorage; this module sends the queue in the background,
// one request at a time, in the order typed, and retries until the server has
// answered.
//
// Retrying is safe. Each entry carries an id made on the phone, and the
// trg_checkpoint_obs_priority trigger drops a second row for the same
// (checkpoint_id, bib_number). When an earlier attempt landed but its response
// was lost, the retry comes back as "already on record", which is the truth.
//
// observed_at is the moment of the tap, never the moment of delivery, so an
// entry delivered five minutes late still carries the right time.

const TIMEOUT_MS = 8000
const TIMEOUT_MAX_MS = 30000
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 15000
const KEEP_DONE = 20

// SQLSTATE classes that mean "try again": connection exception, transaction
// rollback (serialization, deadlock), insufficient resources, operator
// intervention (statement timeout, shutdown), system error.
const TRANSIENT_SQLSTATE_CLASSES = ['08', '40', '53', '57', '58']
// PostgREST's own "cannot reach the database right now" codes: no connection,
// pool timeout, schema cache not loaded. Supabase returns them while it
// restarts or is overloaded.
const TRANSIENT_PGRST_CODES = ['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003']
// Statuses that mean the server has the row. Only these, from another tab,
// override a local 'pending': a 'failed' copy may be one this tab is retrying.
const DELIVERED = new Set(['saved', 'duplicate'])

export function outboxKey(checkpointId) {
  return `leszy.checkpointOutbox.${checkpointId}`
}

/**
 * Turn a supabase-js insert response into an outcome.
 * Returns 'saved' or 'duplicate'; throws an Error whose `permanent` flag says
 * whether retrying can help.
 */
export function classifyInsertResult({ data, error, status }) {
  if (!error) return data && data.length > 0 ? 'saved' : 'duplicate'

  const code = error.code || ''
  if (code === '23505') return 'duplicate'

  const err = new Error(error.message || 'insert failed')
  err.code = code
  err.status = status
  // No code at all is how postgrest-js reports a fetch that never got an
  // answer: offline, DNS, an abort, a gateway error page. A 5xx or 429 is the
  // server saying "not now", whatever code it carries.
  const transient = code === ''
    || status >= 500
    || status === 429
    || TRANSIENT_PGRST_CODES.includes(code)
    || TRANSIENT_SQLSTATE_CLASSES.includes(code.slice(0, 2))
  err.permanent = !transient
  throw err
}

function defaultId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  // randomUUID needs a secure context; getRandomValues does not.
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function defaultSchedule(fn, ms) {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

/**
 * @param {object} opts
 * @param {Storage} opts.storage    localStorage or a stand-in
 * @param {string}  opts.key        storage key, see outboxKey()
 * @param {(entry, signal: AbortSignal) => Promise<'saved'|'duplicate'>} opts.send
 */
export function createOutbox({
  storage,
  key,
  send,
  newId = defaultId,
  now = () => new Date(),
  schedule = defaultSchedule,
  timeoutMs = TIMEOUT_MS,
  keepDone = KEEP_DONE,
}) {
  let items = [] // oldest first
  let persistent = true
  let inFlight = null // { id, token, cancelTimeout }
  let cancelBackoff = null
  let failStreak = 0
  let timeoutStreak = 0
  // Ids this tab cancelled or pruned, so a copy written back by another tab
  // does not bring them back.
  const removed = new Set()
  let reachable = true
  let token = 0
  let stopped = false
  const listeners = new Set()

  try {
    const raw = storage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) {
      items = parsed
        .filter(e => e && typeof e.id === 'string' && Number.isInteger(e.bib))
        // An entry caught mid-send by a reload may or may not have landed.
        // Sending it again is safe, see the note at the top.
        .map(e => (e.status === 'sending' ? { ...e, status: 'pending' } : e))
    }
  } catch {
    // Unreadable storage must not take the page down; start empty.
    items = []
    persistent = isWritable()
  }

  function isWritable() {
    try { storage.setItem(key, storage.getItem(key) ?? '[]'); return true } catch { return false }
  }

  // Two tabs on the same checkpoint share one storage key. Each write first
  // takes in what the other tab stored, or the last writer would erase the
  // other's unsent entries. Both tabs may then send the same entry; the
  // dedup trigger makes that harmless.
  function mergeForeign() {
    let foreign
    try {
      const raw = storage.getItem(key)
      foreign = raw ? JSON.parse(raw) : []
    } catch {
      return false
    }
    if (!Array.isArray(foreign)) return false
    let touched = false
    for (const f of foreign) {
      if (!f || typeof f.id !== 'string' || !Number.isInteger(f.bib) || removed.has(f.id)) continue
      const mine = find(f.id)
      if (!mine) {
        // A 'sending' copy belongs to a request in the other tab that this tab
        // will never see finish, so it is ours to send too.
        items.push({ ...f, status: f.status === 'sending' ? 'pending' : f.status })
        touched = true
        continue
      }
      // An attempt in either tab means the row may be on the server, which is
      // what cancel() and the "Cofnij" button check.
      const attempts = Math.max(mine.attempts || 0, f.attempts || 0)
      if (attempts !== (mine.attempts || 0)) { mine.attempts = attempts; touched = true }
      if (f.status === 'cancelled' && mine.status === 'pending' && !mine.attempts) {
        // Taken back in the other tab before anything was sent there.
        mine.status = 'cancelled'
        touched = true
      } else if (['pending', 'failed', 'cancelled'].includes(mine.status) && DELIVERED.has(f.status)) {
        // The other tab delivered it. The server has the row whatever this tab
        // thought, so show it as on record, even over a local cancel.
        mine.status = f.status
        mine.error = f.error ?? null
        touched = true
      }
    }
    if (touched) items.sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0))
    return touched
  }

  function save() {
    mergeForeign()
    try {
      storage.setItem(key, JSON.stringify(items))
      persistent = true
    } catch {
      persistent = false
    }
  }

  function changed() {
    save()
    for (const fn of listeners) {
      try { fn() } catch (e) { console.error('[outbox] listener failed', e) }
    }
  }

  function find(id) {
    return items.find(e => e.id === id)
  }

  function prune() {
    const done = items.filter(e => e.status === 'saved' || e.status === 'duplicate' || e.status === 'cancelled')
    if (done.length <= keepDone) return
    const drop = new Set(done.slice(0, done.length - keepDone).map(e => e.id))
    for (const id of drop) removed.add(id)
    items = items.filter(e => !drop.has(e.id))
  }

  function scheduleRetry() {
    if (cancelBackoff || stopped) return
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failStreak - 1), BACKOFF_MAX_MS)
    cancelBackoff = schedule(() => { cancelBackoff = null; pump() }, delay)
  }

  function finish(myToken, entry, outcome, err) {
    if (!inFlight || inFlight.token !== myToken) return // abandoned after a timeout
    inFlight.cancelTimeout()
    inFlight = null
    // Any answer from the server, good or bad, means the link carries a round
    // trip again.
    if (outcome || err?.permanent) timeoutStreak = 0
    else if (err?.timeout) timeoutStreak++

    if (outcome) {
      entry.status = outcome
      entry.error = null
      failStreak = 0
      reachable = true
      prune()
      changed()
      pump()
      return
    }

    if (err?.permanent) {
      // The server answered and said no. Retrying will not change that, so
      // stop, keep it on screen, and let the queue behind it move.
      console.error('[outbox] entry rejected', entry.bib, err)
      entry.status = 'failed'
      entry.error = err.message
      reachable = true
      changed()
      pump()
      return
    }

    entry.status = 'pending'
    entry.error = err?.message || 'network'
    failStreak++
    reachable = false
    changed()
    scheduleRetry()
  }

  function pump() {
    if (stopped || inFlight || cancelBackoff) return
    const entry = items.find(e => e.status === 'pending')
    if (!entry) return

    const myToken = ++token
    const controller = new AbortController()
    entry.status = 'sending'
    entry.attempts = (entry.attempts || 0) + 1
    // A link so slow that a round trip takes longer than the timeout would
    // otherwise abort every attempt forever, even while each one lands.
    const wait = Math.min(timeoutMs * 2 ** timeoutStreak, TIMEOUT_MAX_MS)
    const cancelTimeout = schedule(() => {
      controller.abort()
      const err = new Error('timeout')
      err.permanent = false
      err.timeout = true
      finish(myToken, entry, null, err)
    }, wait)
    inFlight = { id: entry.id, token: myToken, cancelTimeout, controller }
    changed()

    let result
    try {
      result = Promise.resolve(send({ ...entry }, controller.signal))
    } catch (e) {
      result = Promise.reject(e)
    }
    result.then(
      outcome => finish(myToken, entry, outcome, null),
      err => finish(myToken, entry, null, err),
    )
  }

  function flush() {
    if (cancelBackoff) { cancelBackoff(); cancelBackoff = null }
    pump()
  }

  // Resume whatever a reload left behind.
  pump()

  return {
    add(bib) {
      const entry = {
        id: newId(),
        bib,
        observedAt: now().toISOString(),
        status: 'pending',
        attempts: 0,
        error: null,
      }
      items.push(entry)
      changed()
      // A fresh tap is a good moment to try again: it often comes right after
      // the signal returned.
      flush()
      return { ...entry }
    },
    // Only an entry never attempted can be taken back. Once a request has gone
    // out it may have landed even if no answer came, and the page has no way
    // to delete it from the server.
    cancel(id) {
      const e = find(id)
      if (!e || e.status !== 'pending' || (e.attempts || 0) > 0) return false
      // Kept as a tombstone in storage, so another tab holding the same entry
      // drops it instead of sending it.
      e.status = 'cancelled'
      prune()
      changed()
      return true
    },
    retry(id) {
      const e = find(id)
      if (!e || e.status !== 'failed') return false
      e.status = 'pending'
      e.error = null
      changed()
      flush()
      return true
    },
    flush,
    // Take in what another tab stored (call on the window 'storage' event).
    sync() {
      if (mergeForeign()) {
        for (const fn of listeners) {
          try { fn() } catch (e) { console.error('[outbox] listener failed', e) }
        }
      }
      pump()
    },
    entries: () => items.filter(e => e.status !== 'cancelled').reverse().map(e => ({ ...e })),
    pendingCount: () => items.filter(e => e.status === 'pending' || e.status === 'sending').length,
    failedCount: () => items.filter(e => e.status === 'failed').length,
    persistent: () => persistent,
    reachable: () => reachable,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    destroy() {
      stopped = true
      if (cancelBackoff) { cancelBackoff(); cancelBackoff = null }
      if (inFlight) { inFlight.cancelTimeout(); inFlight.controller.abort(); inFlight = null }
      listeners.clear()
    },
  }
}
