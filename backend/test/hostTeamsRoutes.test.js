// PUT /api/events/:eventId/host-teams/:teamId and the merged GET .../team-names, against a
// recording stub db (no Postgres): what the handler reads, refuses and writes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { PgDialect } from 'drizzle-orm/pg-core'
import { getTableName } from 'drizzle-orm'
import { participantsRoutes } from '../src/routes/participants.js'

const EVENT = '11111111-2222-4333-8444-555555555555'
const TEAM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const dialect = new PgDialect()

function stubDb({ members = [], existing = null, hostRows = [] } = {}) {
  const log = { selects: [], inserted: [], updated: [] }
  const chain = (value, onEnd) => {
    const c = {}
    for (const m of ['set', 'values', 'where', 'returning']) c[m] = (v) => { if (m === 'values' || m === 'set') onEnd(v); return c }
    c.then = (res, rej) => Promise.resolve(value).then(res, rej)
    return c
  }
  const db = {
    select: () => {
      const c = { table: null, cond: null }
      c.from = (t) => { c.table = getTableName(t); return c }
      c.where = (w) => { c.cond = w; return c }
      c.then = (res, rej) => {
        log.selects.push({ table: c.table, sql: dialect.sqlToQuery(c.cond).sql })
        return Promise.resolve(c.table === 'participants' ? members : c.table === 'host_teams' ? hostRows : []).then(res, rej)
      }
      return c
    },
    insert: (t) => chain([{ id: TEAM }], (v) => log.inserted.push({ table: getTableName(t), v })),
    update: (t) => chain([{ id: TEAM }], (v) => log.updated.push({ table: getTableName(t), v })),
    query: { hostTeams: { findFirst: async () => existing } },
  }
  return { db, log }
}

async function appFor(opts) {
  const { db, log } = stubDb(opts)
  const app = Fastify()
  app.decorate('db', db)
  await app.register(async (api) => { await api.register(participantsRoutes) }, { prefix: '/api' })
  return { app, log }
}
const put = (app, name, teamId = TEAM) => app.inject({ method: 'PUT', url: `/api/events/${EVENT}/host-teams/${teamId}`, payload: { name } })

test('names a host team: reads its live members of that event, inserts the trimmed name', async () => {
  const { app, log } = await appFor({ members: [{ id: 'p1', registrationId: null }] })
  const res = await put(app, '  Renifery ')
  assert.equal(res.statusCode, 200)
  const sel = log.selects.find(s => s.table === 'participants').sql
  assert.match(sel, /"event_id" = \$1/)
  assert.match(sel, /"team_id" = \$2/)
  assert.match(sel, /"removed_at" is null/)
  assert.deepEqual(log.inserted.map(i => [i.table, i.v.id, i.v.eventId, i.v.name]), [['host_teams', TEAM, EVENT, 'Renifery']])
})

test('renames a stored host team in place', async () => {
  const { app, log } = await appFor({ members: [{ id: 'p1', registrationId: null }], existing: { id: TEAM, eventId: EVENT, name: 'Stara' } })
  assert.equal((await put(app, 'Nowa')).statusCode, 200)
  assert.equal(log.inserted.length, 0)
  assert.equal(log.updated[0].v.name, 'Nowa')
})

test('refuses a registration team, an unknown team and a bad id, writing nothing', async () => {
  for (const [opts, name, teamId, status] of [
    [{ members: [{ id: 'p1', registrationId: 'r1' }] }, 'X', TEAM, 409],
    [{ members: [] }, 'X', TEAM, 404],
    [{ members: [{ id: 'p1' }] }, 'X', 'not-a-uuid', 400],
    [{ members: [{ id: 'p1' }] }, '', TEAM, 400],
  ]) {
    const { app, log } = await appFor(opts)
    assert.equal((await put(app, name, teamId)).statusCode, status)
    assert.equal(log.inserted.length + log.updated.length, 0)
  }
})

test('team-names returns the host names offline (no Supabase configured)', async () => {
  const saved = [process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY]
  delete process.env.SUPABASE_URL
  try {
    const { app } = await appFor({ hostRows: [{ id: TEAM, name: 'Renifery' }] })
    const res = await app.inject({ method: 'GET', url: `/api/events/${EVENT}/team-names` })
    assert.deepEqual(res.json(), { data: { [TEAM]: 'Renifery' } })
  } finally {
    if (saved[0] !== undefined) process.env.SUPABASE_URL = saved[0]
  }
})
