// PUT/GET /api/events/:eventId/team-batons against a recording stub db (no Postgres).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { getTableName } from 'drizzle-orm'
import { teamBatonsRoutes } from '../src/routes/teamBatons.js'

const EVENT = '11111111-2222-4333-8444-555555555555'
const TEAM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

async function appFor({ members = [{ id: 'p1' }], tagged = [], batons = [] } = {}) {
  const log = { inserted: [], conflict: null }
  let pSel = 0
  const db = {
    select: () => {
      const c = { table: null }
      c.from = (t) => { c.table = getTableName(t); return c }
      c.where = () => c
      c.then = (res, rej) => Promise.resolve(c.table === 'team_batons' ? batons : c.table === 'participants' ? (pSel++ === 0 ? members : tagged) : []).then(res, rej)
      return c
    },
    insert: () => {
      const c = {}
      c.values = (v) => { log.inserted.push(v); c.v = v; return c }
      c.onConflictDoUpdate = (o) => { log.conflict = o.set; return c }
      c.returning = () => Promise.resolve([{ ...c.v }])
      return c
    },
  }
  const app = Fastify()
  app.decorate('db', db)
  await app.register(async (api) => { await api.register(teamBatonsRoutes) }, { prefix: '/api' })
  return { app, log }
}
const put = (app, epc, teamId = TEAM) => app.inject({ method: 'PUT', url: `/api/events/${EVENT}/team-batons/${teamId}`, payload: { epc } })

test('stores a trimmed upper-case tag in one upsert', async () => {
  const { app, log } = await appFor()
  const res = await put(app, ' ab12 ')
  assert.equal(res.statusCode, 200)
  assert.equal(log.inserted[0].epc, 'AB12')
  assert.equal(log.conflict.epc, 'AB12')
})

test('clearing with null is stored as null', async () => {
  const { app, log } = await appFor()
  assert.equal((await put(app, null)).statusCode, 200)
  assert.equal(log.inserted[0].epc, null)
})

test('refuses a runner tag, another team baton, an unknown team and a bad id, writing nothing', async () => {
  for (const [opts, epc, teamId, status] of [
    [{ tagged: [{ epc: 'ab12' }] }, 'AB12', TEAM, 422],
    [{ batons: [{ teamId: 'other', epc: 'AB12' }] }, 'ab12', TEAM, 422],
    [{ members: [] }, 'AB12', TEAM, 404],
    [{}, 'AB12', 'nope', 400],
    [{}, '', TEAM, 400],
  ]) {
    const { app, log } = await appFor(opts)
    assert.equal((await put(app, epc, teamId)).statusCode, status)
    assert.equal(log.inserted.length, 0)
  }
})

test('GET lists the rows', async () => {
  const { app } = await appFor({ batons: [{ teamId: TEAM, epc: null }] })
  const res = await app.inject({ method: 'GET', url: `/api/events/${EVENT}/team-batons` })
  assert.deepEqual(res.json().data, [{ teamId: TEAM, epc: null }])
})
