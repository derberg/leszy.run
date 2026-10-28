import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deleteStaleCategories } from '../src/sync/supabase.js'

// Supabase stub recording every categories delete with its filters.
function recordingClient() {
  const deletes = []
  return {
    deletes,
    from(table) {
      return {
        delete() {
          const f = { table }
          const chain = {
            eq(col, v) { f[col] = v; return chain },
            neq(col, v) { f[`not_${col}`] = v; deletes.push(f); return Promise.resolve({ error: null }) },
          }
          return chain
        },
      }
    },
  }
}

// Local db stub: the registration events (club_id set) among the asked ids.
function dbWithRegistrationEvents(ids) {
  return { select: () => ({ from: () => ({ where: () => Promise.resolve(ids.map((id) => ({ id }))) }) }) }
}

test('stale-category cleanup skips a registration event and still runs for an ordinary one', async () => {
  const client = recordingClient()
  await deleteStaleCategories(client, dbWithRegistrationEvents(['ev-club']), [
    { id: 'c1', event_id: 'ev-club', slug: '10km' },
    { id: 'c2', event_id: 'ev-plain', slug: '5km' },
  ])
  assert.deepEqual(client.deletes, [{ table: 'categories', event_id: 'ev-plain', slug: '5km', not_id: 'c2' }])
})

test('stale-category cleanup with only registration events deletes nothing', async () => {
  const client = recordingClient()
  await deleteStaleCategories(client, dbWithRegistrationEvents(['ev-club']), [{ id: 'c1', event_id: 'ev-club', slug: '10km' }])
  assert.deepEqual(client.deletes, [])
})
