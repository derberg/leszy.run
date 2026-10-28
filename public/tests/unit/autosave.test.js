import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createAutosave } from '../../src/lib/autosave.js'

// Lets every pending promise callback run (save() resolving, state updates).
const settle = () => new Promise((resolve) => setImmediate(resolve))

function recorder({ failTimes = 0 } = {}) {
  const calls = []
  let failures = failTimes
  const save = async (section, value) => {
    calls.push({ section, value })
    if (failures > 0) {
      failures -= 1
      const err = new Error('Ten adres jest już zajęty.')
      err.fields = { slug: 'Ten adres jest już zajęty.' }
      throw err
    }
  }
  return { calls, save }
}

test('three edits of one section within the delay become one save of the latest value', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { calls, save } = recorder()
  const autosave = createAutosave({ save, delayMs: 1500 })

  autosave.queue('basics', { name: 'B' })
  t.mock.timers.tick(1000)
  autosave.queue('basics', { name: 'Bi' })
  t.mock.timers.tick(1000)
  autosave.queue('basics', { name: 'Bieg' })
  t.mock.timers.tick(1499)
  await settle()
  assert.equal(calls.length, 0)

  t.mock.timers.tick(1)
  await settle()
  assert.deepEqual(calls, [{ section: 'basics', value: { name: 'Bieg' } }])
  assert.ok(autosave.state.savedAt instanceof Date)
  assert.deepEqual(autosave.state.savingSections, [])
  assert.equal(autosave.state.error, null)
})

test('two sections are saved separately, each with its own value', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { calls, save } = recorder()
  const autosave = createAutosave({ save, delayMs: 1500 })

  autosave.queue('basics', { name: 'Bieg' })
  autosave.queue('office', { notes: 'Tylko z upoważnieniem' })
  t.mock.timers.tick(1500)
  await settle()

  assert.equal(calls.length, 2)
  assert.deepEqual(calls.find((c) => c.section === 'basics').value, { name: 'Bieg' })
  assert.deepEqual(calls.find((c) => c.section === 'office').value, { notes: 'Tylko z upoważnieniem' })
})

test('a rejected save keeps the value queued, surfaces the error, and the next flush retries it', async () => {
  const { calls, save } = recorder({ failTimes: 1 })
  const autosave = createAutosave({ save, delayMs: 1500 })

  autosave.queue('basics', { slug: 'zajety' })
  assert.equal(await autosave.flush(), false)
  assert.equal(autosave.state.error.section, 'basics')
  assert.equal(autosave.state.error.message, 'Ten adres jest już zajęty.')
  assert.deepEqual(autosave.state.error.fields, { slug: 'Ten adres jest już zajęty.' })
  assert.equal(autosave.hasPending(), true)

  assert.equal(await autosave.flush(), true)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], { section: 'basics', value: { slug: 'zajety' } })
  assert.equal(autosave.state.error, null)
  assert.equal(autosave.hasPending(), false)
})

test('a newer value queued while the failing save was in flight wins over the failed one', async () => {
  let release
  const calls = []
  const save = (section, value) => {
    calls.push(value)
    if (calls.length === 1) return new Promise((_, reject) => { release = () => reject(new Error('boom')) })
    return Promise.resolve()
  }
  const autosave = createAutosave({ save, delayMs: 1500 })

  autosave.queue('basics', { name: 'old' })
  const first = autosave.flush()
  await settle()
  autosave.queue('basics', { name: 'new' })
  release()
  await first
  assert.equal(await autosave.flush(), true)
  assert.deepEqual(calls, [{ name: 'old' }, { name: 'new' }])
})

test('one section is never saved twice at once: a value queued mid-save waits for it', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const save = async () => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await settle()
    inFlight -= 1
  }
  const autosave = createAutosave({ save, delayMs: 1500 })
  autosave.queue('basics', { name: 'a' })
  const first = autosave.flush()
  autosave.queue('basics', { name: 'b' })
  await Promise.all([first, autosave.flush()])
  assert.equal(maxInFlight, 1)
})

test('subscribers see the section saving, then saved', async () => {
  const autosave = createAutosave({ save: async () => {}, delayMs: 1500 })
  const seen = []
  const unsubscribe = autosave.subscribe((s) => seen.push(s.savingSections.join(',')))
  autosave.queue('office', { notes: 'x' })
  await autosave.flush()
  unsubscribe()
  assert.deepEqual(seen.filter(Boolean), ['office'])
  assert.equal(seen.at(-1), '')
})

test('dispose drops a queued save', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { calls, save } = recorder()
  const autosave = createAutosave({ save, delayMs: 1500 })
  autosave.queue('basics', { name: 'x' })
  autosave.dispose()
  t.mock.timers.tick(5000)
  await settle()
  assert.equal(calls.length, 0)
})

mock.reset()
