// Autosave for the registration wizard: one pending value per section (the
// latest wins; a function is called when its save starts), each section saved
// on its own timer, never two saves of one section at once. A failed save
// keeps its value queued and surfaces the error; the next queue() or flush()
// retries it. A failure that is not a
// refusal of the value (network, 5xx) is also retried on its own after
// 2 s, 5 s and 15 s. A 4xx is not: it would only fail again until the
// organizer changes the value.
//
// createAutosave({ save, delayMs, retryDelaysMs }) → { queue, flush, hasPending, subscribe, dispose, state }
//   state: { savingSections: string[], savedAt: Date|null, error: { section, message, fields }|null }
//
// dispose() ends it: call it right after the final flush() (on unmount). A
// save still in flight then finishes without being re-queued or retried,
// pending retries are cancelled, and queue()/flush() do nothing afterwards.

const RETRY_DELAYS_MS = [2000, 5000, 15000]

const retryable = (err) => !(err?.status >= 400 && err?.status < 500)

export function createAutosave({ save, delayMs = 1500, retryDelaysMs = RETRY_DELAYS_MS }) {
  const pending = new Map() // section → latest unsaved value
  const timers = new Map() // section → timeout id
  const running = new Map() // section → promise of the save in flight
  const errors = new Map() // section → { section, message, fields }
  const attempts = new Map() // section → automatic retries used since the last success
  const listeners = new Set()
  let disposed = false
  let savedAt = null
  let state = snapshot()

  function snapshot() {
    const [error = null] = errors.values()
    return { savingSections: [...running.keys()], savedAt, error }
  }

  function emit() {
    state = snapshot()
    for (const listener of listeners) listener(state)
  }

  async function run(section) {
    // Wait out a save of the same section, then save whatever is newest.
    while (running.has(section)) await running.get(section)
    if (!pending.has(section)) return
    const queued = pending.get(section)
    pending.delete(section)
    // A function is read now, so it sees what the previous save taught the
    // caller (ids of rows it created).
    const value = typeof queued === 'function' ? queued() : queued

    const attempt = (async () => {
      try {
        await save(section, value)
        errors.delete(section)
        attempts.delete(section)
        savedAt = new Date()
      } catch (err) {
        if (disposed) return
        if (!pending.has(section)) pending.set(section, queued)
        errors.set(section, { section, message: err?.message ?? 'Nie udało się zapisać.', fields: err?.fields ?? null })
        const used = attempts.get(section) ?? 0
        if (retryable(err) && used < retryDelaysMs.length && !timers.has(section)) {
          attempts.set(section, used + 1)
          schedule(section, retryDelaysMs[used])
        }
      }
    })()
    running.set(section, attempt)
    emit()
    await attempt
    running.delete(section)
    emit()
  }

  function schedule(section, ms) {
    if (disposed) return
    clearTimeout(timers.get(section))
    timers.set(section, setTimeout(() => {
      timers.delete(section)
      run(section)
    }, ms))
  }

  function queue(section, value) {
    if (disposed) return
    pending.set(section, value)
    attempts.delete(section)
    schedule(section, delayMs)
  }

  /** Saves everything queued now. Resolves true when nothing failed. */
  async function flush() {
    for (const id of timers.values()) clearTimeout(id)
    timers.clear()
    const sections = new Set([...pending.keys(), ...running.keys()])
    await Promise.all([...sections].map(run))
    return errors.size === 0
  }

  return {
    queue,
    flush,
    hasPending: () => pending.size > 0 || running.size > 0,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      disposed = true
      for (const id of timers.values()) clearTimeout(id)
      timers.clear()
      pending.clear()
      attempts.clear()
      errors.clear()
      listeners.clear()
    },
    get state() { return state },
  }
}
