import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createArmer } from '../src/armer.js'

// Builds a fake supabase where categories for the event always resolve to
// one category ('c1'), and race_runs for that category are whatever
// `getRuns()` currently returns — lets tests flip from "not started" to
// "started" mid-test.
function fakeSupabase(getRuns) {
  return {
    from(table) {
      if (table === 'categories') {
        return { select: () => ({ eq: async () => ({ data: [{ id: 'c1' }], error: null }) }) }
      }
      if (table === 'race_runs') {
        return { select: () => ({ in: () => ({ in: async () => ({ data: getRuns(), error: null }) }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

test('check() is false with no active/finished race_runs, true once one appears', async () => {
  let runs = []
  const armer = createArmer({ supabase: fakeSupabase(() => runs), eventId: 'ev1', pollMs: 10 })
  assert.equal(await armer.check(), false)
  runs = [{ id: 'r1' }]
  assert.equal(await armer.check(), true)
})

test('check() returns false (never throws) when the categories query errors', async () => {
  const supabase = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { message: 'boom' } }) }) }) }
  const armer = createArmer({ supabase, eventId: 'ev1', pollMs: 10 })
  assert.equal(await armer.check(), false)
})

test('check() returns false (never throws) when the client throws', async () => {
  const supabase = { from: () => ({ select: () => ({ eq: async () => { throw new Error('network down') } }) }) }
  const armer = createArmer({ supabase, eventId: 'ev1', pollMs: 10 })
  assert.equal(await armer.check(), false)
})

test('check() returns false when the event has no categories at all (race_runs never queried)', async () => {
  let raceRunsQueried = false
  const supabase = {
    from(table) {
      if (table === 'categories') return { select: () => ({ eq: async () => ({ data: [], error: null }) }) }
      raceRunsQueried = true
      return { select: () => ({ in: () => ({ in: async () => ({ data: [{ id: 'r1' }], error: null }) }) }) }
    },
  }
  const armer = createArmer({ supabase, eventId: 'ev1', pollMs: 10 })
  assert.equal(await armer.check(), false)
  assert.equal(raceRunsQueried, false)
})

test('start() polls every pollMs and calls onArmed exactly once when the race goes active, then stops polling', async () => {
  let runs = []
  const armer = createArmer({ supabase: fakeSupabase(() => runs), eventId: 'ev1', pollMs: 15 })
  let armedCount = 0
  armer.start(() => { armedCount += 1 })

  await new Promise((r) => setTimeout(r, 40))
  assert.equal(armedCount, 0) // still not started

  runs = [{ id: 'r1' }]
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(armedCount, 1)

  // Further ticks must not fire onArmed again — start() stops itself once armed.
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(armedCount, 1)
})

test('stop() prevents a pending poll from ever firing onArmed', async () => {
  const armer = createArmer({ supabase: fakeSupabase(() => [{ id: 'r1' }]), eventId: 'ev1', pollMs: 20 })
  let armedCount = 0
  armer.start(() => { armedCount += 1 })
  armer.stop()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(armedCount, 0)
})

test('start() is idempotent — calling it twice does not create a second interval', async () => {
  let runs = [{ id: 'r1' }]
  const armer = createArmer({ supabase: fakeSupabase(() => runs), eventId: 'ev1', pollMs: 15 })
  let armedCount = 0
  armer.start(() => { armedCount += 1 })
  armer.start(() => { armedCount += 1 }) // second call ignored — original callback still wired
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(armedCount, 1)
})

// --- disarming ---------------------------------------------------------------
// An agent that stays armed after its race_run is cancelled or deleted keeps
// recording, and because checkpoint_observations is UNIQUE(checkpoint_id,
// bib_number) with a drop-on-conflict trigger, those reads permanently occupy
// each runner's slot — their real pass in the next run can never be stored.

test('probe() distinguishes "definitely not armed" from "could not tell"', async () => {
  const noRuns = createArmer({ supabase: fakeSupabase(() => []), eventId: 'ev1', pollMs: 10 })
  assert.deepEqual(await noRuns.probe(), { ok: true, armed: false })

  const withRun = createArmer({ supabase: fakeSupabase(() => [{ id: 'r1' }]), eventId: 'ev1', pollMs: 10 })
  assert.deepEqual(await withRun.probe(), { ok: true, armed: true })

  const erroring = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { message: 'boom' } }) }) }) }
  assert.deepEqual(await createArmer({ supabase: erroring, eventId: 'ev1', pollMs: 10 }).probe(), { ok: false })

  const throwing = { from: () => { throw new Error('network') } }
  assert.deepEqual(await createArmer({ supabase: throwing, eventId: 'ev1', pollMs: 10 }).probe(), { ok: false })
})

test('watch() disarms when the race run disappears', async (t) => {
  let runs = [{ id: 'r1' }]
  const armer = createArmer({ supabase: fakeSupabase(() => runs), eventId: 'ev1', pollMs: 10 })
  t.after(() => armer.stop())
  const seen = []
  armer.watch((armed) => seen.push(armed), true) // start from "already armed"

  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(seen, [], 'no transition while the run still exists')

  runs = [] // run cancelled / deleted
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(seen, [false], 'disarmed exactly once')
})

test('watch() re-arms when a new run appears, and reports both directions', async (t) => {
  let runs = []
  const armer = createArmer({ supabase: fakeSupabase(() => runs), eventId: 'ev1', pollMs: 10 })
  t.after(() => armer.stop())
  const seen = []
  armer.watch((armed) => seen.push(armed), false)

  runs = [{ id: 'r1' }]
  await new Promise((r) => setTimeout(r, 50))
  runs = []
  await new Promise((r) => setTimeout(r, 60))
  runs = [{ id: 'r2' }]
  await new Promise((r) => setTimeout(r, 60))

  assert.deepEqual(seen, [true, false, true])
})

// The important safety property: a transient failure must NOT drop real reads.
test('watch() never disarms on an indeterminate probe', async (t) => {
  let fail = false
  const supabase = {
    from(table) {
      if (fail) throw new Error('network down')
      if (table === 'categories') return { select: () => ({ eq: async () => ({ data: [{ id: 'c1' }], error: null }) }) }
      return { select: () => ({ in: () => ({ in: async () => ({ data: [{ id: 'r1' }], error: null }) }) }) }
    },
  }
  const armer = createArmer({ supabase, eventId: 'ev1', pollMs: 10 })
  t.after(() => armer.stop())
  const seen = []
  armer.watch((armed) => seen.push(armed), true)

  fail = true
  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual(seen, [], 'stayed armed through the outage')

  fail = false
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(seen, [], 'and still armed once it recovered')
})
