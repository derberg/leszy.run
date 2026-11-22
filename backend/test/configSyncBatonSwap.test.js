// configSync: two teams' baton tags swapped within one sync cycle must both apply. The
// (event_id, epc) unique is DEFERRABLE INITIALLY DEFERRED, so the event's rows are applied in
// one transaction and only the committed state must be unique; row by row, each row would
// collide with the other team's old tag forever.
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

// A local team_batons table with the deferred unique: a statement outside a transaction is
// checked at once (autocommit), inside db.transaction only at commit.
function batonDb(initial) {
  let rows = new Map(initial.map(r => [r.id, { ...r }]))
  const unique = (state) => {
    const seen = new Set()
    for (const r of state.values()) {
      if (!r.epc) continue
      const k = `${r.eventId}:${r.epc}`
      if (seen.has(k)) throw new Error('duplicate key value violates unique constraint "team_batons_event_epc_key"')
      seen.add(k)
    }
  }
  const upsert = (state, v) => {
    const cur = state.get(v.id)
    if (cur && cur.syncedAt === null) return // setWhere: a locally dirty row is never overwritten
    state.set(v.id, { ...cur, ...v })
  }
  const api = (getState, deferred) => ({
    select: () => ({
      from: (t) => {
        const value = () => (getTableName(t) === 'team_batons' ? [...getState().values()].map(r => ({ ...r, teamId: r.teamId ?? r.id })) : [])
        return Object.assign(Promise.resolve().then(value), {
          where: () => Promise.resolve().then(() => value().filter(r => r.epc)),
        })
      },
    }),
    insert: (t) => ({
      values: (v) => ({
        onConflictDoUpdate: async () => {
          if (getTableName(t) !== 'team_batons') return
          const state = getState()
          const before = new Map([...state].map(([k, r]) => [k, { ...r }]))
          upsert(state, v)
          if (!deferred) {
            try { unique(state) } catch (e) { state.clear(); for (const [k, r] of before) state.set(k, r); throw e }
          }
        },
      }),
    }),
  })
  const db = api(() => rows, false)
  db.transaction = async (fn) => {
    const draft = new Map([...rows].map(([k, r]) => [k, { ...r }]))
    const result = await fn(api(() => draft, true))
    unique(draft) // COMMIT checks the deferred constraint
    rows = draft
    return result
  }
  db.rows = () => rows
  return db
}

test('a swap of two teams\' batons pulled in one poll applies both rows', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const synced = new Date('2026-11-21T10:00:00Z')
  const db = batonDb([
    { id: 'T1', teamId: 'T1', eventId: EV, epc: 'A', syncedAt: synced },
    { id: 'T2', teamId: 'T2', eventId: EV, epc: 'B', syncedAt: synced },
  ])
  const calls = []
  await pullConfig(db, supabaseWith([
    { id: 'T1', team_id: 'T1', event_id: EV, epc: 'B' },
    { id: 'T2', team_id: 'T2', event_id: EV, epc: 'A' },
  ]), { getDetector: () => ({ reloadBatons: (e, b) => calls.push([e, b]) }) })
  assert.equal(db.rows().get('T1').epc, 'B')
  assert.equal(db.rows().get('T2').epc, 'A')
  assert.deepEqual(calls.length, 1)
  assert.deepEqual(calls[0][1].map(b => [b.teamId, b.epc]).sort(), [['T1', 'B'], ['T2', 'A']])
})

test('a pulled change that collides with a locally dirty row leaves that row and still applies the others', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const synced = new Date('2026-11-21T10:00:00Z')
  const db = batonDb([
    { id: 'T1', teamId: 'T1', eventId: EV, epc: 'A', syncedAt: null },   // local edit not pushed yet
    { id: 'T2', teamId: 'T2', eventId: EV, epc: 'B', syncedAt: synced },
    { id: 'T3', teamId: 'T3', eventId: EV, epc: 'C', syncedAt: synced },
  ])
  await pullConfig(db, supabaseWith([
    { id: 'T1', team_id: 'T1', event_id: EV, epc: 'B' },
    { id: 'T2', team_id: 'T2', event_id: EV, epc: 'A' },
    { id: 'T3', team_id: 'T3', event_id: EV, epc: 'D' },
  ]), { getDetector: () => null })
  assert.equal(db.rows().get('T1').epc, 'A', 'the dirty row wins')
  assert.equal(db.rows().get('T2').epc, 'B', 'its new tag is the dirty row\'s: refused this poll')
  assert.equal(db.rows().get('T3').epc, 'D', 'an unrelated change still applies')
})
