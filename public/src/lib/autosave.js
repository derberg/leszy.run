// Autosave for the registration wizard: one pending value per section (the
// latest wins), each section saved on its own timer, never two saves of one
// section at once. A failed save keeps its value queued and surfaces the
// error; the next queue() or flush() retries it. There is no automatic retry
// loop: a 422 would only fail again until the organizer changes the value.
//
// createAutosave({ save, delayMs }) → { queue, flush, hasPending, subscribe, dispose, state }
//   state: { savingSections: string[], savedAt: Date|null, error: { section, message, fields }|null }

export function createAutosave({ save, delayMs = 1500 }) {
  const pending = new Map() // section → latest unsaved value
  const timers = new Map() // section → timeout id
  const running = new Map() // section → promise of the save in flight
  const errors = new Map() // section → { section, message, fields }
  const listeners = new Set()
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
    const value = pending.get(section)
    pending.delete(section)

    const attempt = (async () => {
      try {
        await save(section, value)
        errors.delete(section)
        savedAt = new Date()
      } catch (err) {
        if (!pending.has(section)) pending.set(section, value)
        errors.set(section, { section, message: err?.message ?? 'Nie udało się zapisać.', fields: err?.fields ?? null })
      }
    })()
    running.set(section, attempt)
    emit()
    await attempt
    running.delete(section)
    emit()
  }

  function queue(section, value) {
    pending.set(section, value)
    clearTimeout(timers.get(section))
    timers.set(section, setTimeout(() => {
      timers.delete(section)
      run(section)
    }, delayMs))
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
      for (const id of timers.values()) clearTimeout(id)
      timers.clear()
      pending.clear()
      listeners.clear()
    },
    get state() { return state },
  }
}
