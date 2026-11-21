// PUT /api/events/:eventId/host-teams/:teamId and the merged GET .../team-names, against a
// recording stub db (no Postgres): what the handler reads, refuses and writes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { PgDialect } from 'drizzle-orm/pg-core'
import { getTableName } from 'drizzle-orm'
import { participantsRoutes } from '../src/routes/participants.js'
import { resultsRoutes } from '../src/routes/results.js'

const EVENT = '11111111-2222-4333-8444-555555555555'
const TEAM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const dialect = new PgDialect()

function stubDb({ members = [], existing = null, hostRows = [], upserted = [{ id: TEAM }], run = null, runResults = [] } = {}) {
  const log = { selects: [], inserted: [], updated: [] }
  const chain = (value, onEnd) => {
    const c = {}
    for (const m of ['set', 'values', 'where', 'returning']) c[m] = (v) => { if (m === 'values' || m === 'set') onEnd(v); return c }
    c.onConflictDoUpdate = (o) => { log.conflict = { set: o.set, setWhere: dialect.sqlToQuery(o.setWhere).sql }; return c }
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
    insert: (t) => chain(upserted, (v) => log.inserted.push({ table: getTableName(t), v })),
    update: (t) => chain([{ id: TEAM }], (v) => log.updated.push({ table: getTableName(t), v })),
    query: {
      hostTeams: { findFirst: async () => existing },
      raceRuns: { findFirst: async () => run },
      results: { findMany: async () => runResults },
    },
  }
  return { db, log }
}

async function appFor(opts, routes = participantsRoutes) {
  const { db, log } = stubDb(opts)
  const app = Fastify()
  app.decorate('db', db)
  await app.register(async (api) => { await api.register(routes) }, { prefix: '/api' })
  return { app, log }
}
const put = (app, name, teamId = TEAM) => app.inject({ method: 'PUT', url: `/api/events/${EVENT}/host-teams/${teamId}`, payload: { name } })

test('names a host team in one upsert: reads its live members of that event, stores the trimmed name', async () => {
  const { app, log } = await appFor({ members: [{ id: 'p1', registrationId: null }] })
  const res = await put(app, '  Renifery ')
  assert.equal(res.statusCode, 200)
  const sel = log.selects.find(s => s.table === 'participants').sql
  assert.match(sel, /"event_id" = \$1/)
  assert.match(sel, /"team_id" = \$2/)
  assert.match(sel, /"removed_at" is null/)
  assert.match(sel, /"deleted_at" is null/)
  assert.deepEqual(log.inserted.map(i => [i.table, i.v.id, i.v.eventId, i.v.name]), [['host_teams', TEAM, EVENT, 'Renifery']])
  assert.equal(log.conflict.set.name, 'Renifery', 'a concurrent first name updates instead of failing on the primary key')
  assert.match(log.conflict.setWhere, /"event_id" = \$1/)
})

test('a row of another event under the id is not overwritten: 409', async () => {
  const { app } = await appFor({ members: [{ id: 'p1', registrationId: null }], upserted: [] })
  assert.equal((await put(app, 'Nowa')).statusCode, 409)
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

test('team-names returns the host names offline, minus teams with a live registration member', async () => {
  const saved = process.env.SUPABASE_URL
  delete process.env.SUPABASE_URL
  try {
    const OTHER = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const { app, log } = await appFor({
      hostRows: [{ id: TEAM, name: 'Renifery' }, { id: OTHER, name: 'Elfy' }],
      members: [{ teamId: OTHER }],
    })
    const res = await app.inject({ method: 'GET', url: `/api/events/${EVENT}/team-names` })
    assert.deepEqual(res.json(), { data: { [TEAM]: 'Renifery' } })
    const sel = log.selects.find(s => s.table === 'participants').sql
    for (const f of [/"registration_id" is not null/, /"removed_at" is null/, /"deleted_at" is null/]) assert.match(sel, f)
  } finally {
    if (saved !== undefined) process.env.SUPABASE_URL = saved
  }
})

test('race teams standings use the same filter: a host name is dropped once a registration runner is in the team', async () => {
  const saved = process.env.SUPABASE_URL
  delete process.env.SUPABASE_URL
  try {
    const OTHER = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const person = (id, teamId, lastName) => ({ id: `r-${id}`, participantId: id, status: 'started', participant: { id, teamId, lastName, firstName: 'X' } })
    const { app } = await appFor({
      run: { id: 'run1', status: 'active', startedAt: new Date().toISOString(), category: { eventId: EVENT, teamMode: 'relay_free' } },
      runResults: [person('a', TEAM, 'Nowak'), person('b', OTHER, 'Kowal')],
      hostRows: [{ id: TEAM, name: 'Renifery' }, { id: OTHER, name: 'Elfy' }],
      members: [{ teamId: OTHER }],
    }, resultsRoutes)
    const res = await app.inject({ method: 'GET', url: '/api/races/run1/teams' })
    assert.equal(res.statusCode, 200)
    const names = Object.fromEntries(res.json().data.map(t => [t.teamId, t.name]))
    assert.equal(names[TEAM], 'Renifery')
    assert.notEqual(names[OTHER], 'Elfy')
  } finally {
    if (saved !== undefined) process.env.SUPABASE_URL = saved
  }
})
