import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchTeamNames } from '../src/lib/teamNames.js'

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
