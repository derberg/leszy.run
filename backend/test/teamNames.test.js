import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchTeamNames, fetchRegistrationTeamIds } from '../src/lib/teamNames.js'

const EVENT = '11111111-2222-3333-4444-555555555555'
const fake = (result) => ({ calls: [], async rpc(name, args) { this.calls.push([name, args]); if (result instanceof Error) throw result; return result } })

test('maps team ids to names from results_team_names', async () => {
  const sb = fake({ data: [{ team_id: 'a', name: 'Mikołaje' }, { team_id: 'b', name: 'Renifery' }], error: null })
  assert.deepEqual(await fetchTeamNames(sb, EVENT), { a: 'Mikołaje', b: 'Renifery' })
  assert.deepEqual(sb.calls, [['results_team_names', { p_event_id: EVENT }]])
})

test('no Supabase, a bad id, an error or a throw give no names', async () => {
  assert.deepEqual(await fetchTeamNames(null, EVENT), {})
  const sb = fake({ data: [], error: null })
  assert.deepEqual(await fetchTeamNames(sb, 'not-a-uuid'), {})
  assert.equal(sb.calls.length, 0)
  assert.deepEqual(await fetchTeamNames(fake({ data: null, error: { message: 'boom' } }), EVENT), {})
  assert.deepEqual(await fetchTeamNames(fake(new Error('offline')), EVENT), {})
})

test('registration team ids come from Supabase teams of the event; none offline or on an error', async () => {
  const calls = []
  const sb = { from: (t) => ({ select: (c) => ({ eq: async (k, v) => { calls.push([t, c, k, v]); return { data: [{ id: 'r1' }, { id: 'r2' }], error: null } } }) }) }
  assert.deepEqual(await fetchRegistrationTeamIds(sb, EVENT), ['r1', 'r2'])
  assert.deepEqual(calls, [['teams', 'id', 'event_id', EVENT]])
  assert.deepEqual(await fetchRegistrationTeamIds(null, EVENT), [])
  const bad = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { message: 'x' } }) }) }) }
  assert.deepEqual(await fetchRegistrationTeamIds(bad, EVENT), [])
})

test('a Supabase read that hangs gives up after the timeout, aborting the query, and falls back', async () => {
  const signals = []
  const hanging = () => {
    const q = new Promise(() => {})
    q.abortSignal = (s) => { signals.push(s); return q }
    return q
  }
  const sb = { rpc: hanging, from: () => ({ select: () => ({ eq: hanging }) }) }
  const t0 = Date.now()
  assert.deepEqual(await fetchTeamNames(sb, EVENT, { timeoutMs: 50 }), {})
  assert.deepEqual(await fetchRegistrationTeamIds(sb, EVENT, { timeoutMs: 50 }), [])
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(signals.length, 2)
  assert.ok(signals.every(s => s instanceof AbortSignal))
})

test('the default timeout is about 3 s', async () => {
  const { SUPABASE_TIMEOUT_MS } = await import('../src/lib/teamNames.js')
  assert.equal(SUPABASE_TIMEOUT_MS, 3000)
})
