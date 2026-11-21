// configSync: a pulled baton change reaches a running race (detector.reloadBatons).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTableName } from 'drizzle-orm'
import { pullConfig } from '../src/sync/configSync.js'

const EV = 'ev-1'
function supabaseWith(batons) {
  return {
    from(table) {
      return {
        select() {
          return {
            order() { return this },
            range(from) {
              if (from > 0) return Promise.resolve({ data: [], error: null })
              if (table === 'events') return Promise.resolve({ data: [{ id: EV, name: 'Sztafeta' }], error: null })
              if (table === 'team_batons') return Promise.resolve({ data: batons, error: null })
              return Promise.resolve({ data: [], error: null })
            },
          }
        },
      }
    },
  }
}

// Local db: team_batons holds `local` before the pull and `after` once it ran.
function dbWith(local, after) {
  let pulled = false
  const db = {
    select: () => ({
      from: (t) => {
        const name = getTableName(t)
        const value = () => (name === 'team_batons' ? (pulled ? after : local) : [])
        return Object.assign(Promise.resolve().then(value), { where: () => Promise.resolve().then(value) })
      },
    }),
    insert: (t) => ({
      values: () => ({ onConflictDoUpdate: () => { if (getTableName(t) === 'team_batons') pulled = true; return Promise.resolve() } }),
    }),
    transaction: (fn) => fn(db),
  }
  return db
}

test('a changed baton is reloaded into the detector with the event\'s batons that have a tag', async (t) => {
  t.mock.method(console, 'log', () => {})
  const calls = []
  const detector = { reloadBatons: (eventId, batons) => calls.push([eventId, batons]) }
  const db = dbWith(
    [{ id: 'T1', epc: 'OLD' }],
    [{ teamId: 'T1', epc: 'NEW' }],
  )
  await pullConfig(db, supabaseWith([{ id: 'T1', team_id: 'T1', event_id: EV, epc: 'NEW' }]), { getDetector: () => detector })
  assert.deepEqual(calls, [[EV, [{ teamId: 'T1', epc: 'NEW' }]]])
})

test('an unchanged baton reloads nothing, and no detector is fine', async (t) => {
  t.mock.method(console, 'log', () => {})
  const calls = []
  const detector = { reloadBatons: (...a) => calls.push(a) }
  const remote = [{ id: 'T1', team_id: 'T1', event_id: EV, epc: 'B1' }]
  await pullConfig(dbWith([{ id: 'T1', epc: 'B1' }], []), supabaseWith(remote), { getDetector: () => detector })
  assert.deepEqual(calls, [])
  await pullConfig(dbWith([], []), supabaseWith(remote), { getDetector: () => null })
})
