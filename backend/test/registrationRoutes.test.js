// Route-level checks with a recording stub db (no Postgres in tests): the where-clauses
// are rendered to SQL so "removed_at is null" is asserted on what the handler really built.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { PgDialect } from 'drizzle-orm/pg-core'
import { getTableName } from 'drizzle-orm'
import { eventsRoutes } from '../src/routes/events.js'
import { categoriesRoutes } from '../src/routes/categories.js'
import { participantsRoutes } from '../src/routes/participants.js'
import { racesRoutes } from '../src/routes/races.js'
import { smsRoutes } from '../src/routes/sms.js'
import { REGISTRATION_DELETE_REFUSAL } from '../src/lib/registrationGuards.js'

const dialect = new PgDialect()
const render = (cond) => (cond ? dialect.sqlToQuery(cond).sql : '')
const REMOVED_FILTER = '"removed_at" is null'

// handlers: { select(table, whereSql) -> rows, first(table, opts) -> row, many(table, opts) -> rows, insertReturning(table) -> rows }
function stubDb(h = {}) {
  const log = { selects: [], inserted: [], finds: [], deleted: [] }
  const thenable = (value) => {
    const c = {
      where: () => c,
      values: (v) => { log.inserted.push({ table: c.table, values: v }); return c },
      onConflictDoNothing: () => c, onConflictDoUpdate: () => c,
      returning: () => c,
      then: (res, rej) => Promise.resolve(value()).then(res, rej),
    }
    return c
  }
  const db = {
    select: () => {
      const c = { table: null, cond: null }
      for (const m of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) c[m] = (t) => { if (m === 'from') c.table = getTableName(t); return c }
      c.where = (w) => { c.cond = w; return c }
      c.then = (res, rej) => {
        const sql = render(c.cond)
        log.selects.push({ table: c.table, sql })
        return Promise.resolve(h.select ? h.select(c.table, sql) : []).then(res, rej)
      }
      return c
    },
    insert: (t) => { const c = thenable(() => (h.insertReturning ? h.insertReturning(getTableName(t)) : [])); c.table = getTableName(t); return c },
    delete: (t) => thenable(() => { log.deleted.push(getTableName(t)); return [{ id: 'x' }] }),
    update: () => { const c = { set: () => c, where: () => c, returning: () => c, then: (r) => Promise.resolve([{ id: 'x' }]).then(r) }; return c },
    query: new Proxy({}, {
      get: (_, name) => ({
        findFirst: async (opts) => { log.finds.push({ name, sql: render(opts?.where) }); return h.first ? h.first(name, opts) : null },
        findMany: async (opts) => { log.finds.push({ name, sql: render(opts?.where) }); return h.many ? h.many(name, opts) : [] },
      }),
    }),
  }
  return { db, log }
}

async function appFor(h) {
  const { db, log } = stubDb(h)
  const app = Fastify()
  app.decorate('db', db)
  await app.register(async (api) => {
    for (const r of [eventsRoutes, categoriesRoutes, participantsRoutes, racesRoutes, smsRoutes]) await api.register(r)
  }, { prefix: '/api' })
  return { app, log }
}

const regEvent = { id: 'e1', clubId: 'club1', slug: 's' }

test('start race seeds and starts only participants not removed online', async () => {
  const { app, log } = await appFor({
    first: (n) => (n === 'categories' ? { id: 'c1', event: {} } : null),
    many: (n) => (n === 'participants'
      ? [{ id: 'a' }, { id: 'b', removedAt: new Date() }, { id: 'c', withdrawnAt: new Date() }] : []),
    insertReturning: (t) => (t === 'race_runs' ? [{ id: 'r1', categoryId: 'c1' }] : []),
  })
  const res = await app.inject({ method: 'POST', url: '/api/categories/c1/races' })
  assert.equal(res.statusCode, 201)
  const seeded = log.inserted.find((i) => i.table === 'results').values
  assert.deepEqual(seeded.map((r) => [r.participantId, r.status]), [['a', 'registered'], ['c', 'dns']])
})

test('SMS check-in-all skips removed participants', async () => {
  const { app, log } = await appFor({ first: () => regEvent })
  const res = await app.inject({ method: 'POST', url: '/api/events/e1/sms/checkin-all' })
  assert.equal(res.statusCode, 200)
  const q = log.finds.find((f) => f.name === 'participants')
  assert.ok(q.sql.includes(REMOVED_FILTER), q.sql)
})

test('participants list hides removed rows', async () => {
  const { app, log } = await appFor()
  const res = await app.inject({ method: 'GET', url: '/api/events/e1/participants' })
  assert.equal(res.statusCode, 200)
  assert.ok(log.finds.find((f) => f.name === 'participants').sql.includes(REMOVED_FILTER))
})

test('deletes on a registration event answer 409 with the refusal', async () => {
  const { app, log } = await appFor({
    first: (n) => (n === 'events' ? regEvent : { eventId: 'e1' }),
  })
  for (const url of ['/api/events/e1', '/api/categories/c1', '/api/participants/p1']) {
    const res = await app.inject({ method: 'DELETE', url })
    assert.equal(res.statusCode, 409, url)
    assert.deepEqual(res.json(), { error: 'Wydarzenie z zapisami online — usuwanie wyłączone.' })
  }
  assert.equal(REGISTRATION_DELETE_REFUSAL, 'Wydarzenie z zapisami online — usuwanie wyłączone.')
  assert.deepEqual(log.deleted, [])
})

test('deletes on an ordinary event still go through', async () => {
  const { app } = await appFor({ first: (n) => (n === 'events' ? { id: 'e1', clubId: null } : { eventId: 'e1' }) })
  const res = await app.inject({ method: 'DELETE', url: '/api/events/e1' })
  assert.equal(res.statusCode, 200)
})

test('withdraw and its undo answer 409 for a participant removed online', async () => {
  const { app } = await appFor({ first: () => ({ id: 'p1', removedAt: new Date() }) })
  for (const method of ['POST', 'DELETE']) {
    const res = await app.inject({ method, url: '/api/participants/p1/withdraw' })
    assert.equal(res.statusCode, 409)
    assert.deepEqual(res.json(), { error: 'Zawodnik wycofany z zapisów online.' })
  }
})

test('missingStart query excludes removed participants', async () => {
  const { app, log } = await appFor({ first: () => ({ id: 'r1', categoryId: 'c1' }) })
  const res = await app.inject({ method: 'GET', url: '/api/races/r1/audit' })
  assert.equal(res.statusCode, 200)
  const q = log.selects.find((s) => s.table === 'participants')
  assert.ok(q.sql.includes(REMOVED_FILTER), q.sql)
})

test('assign-gun-start never writes a result for a removed participant', async () => {
  const { app, log } = await appFor({
    first: (n) => (n === 'raceRuns' ? { id: 'r1', status: 'active', startedAt: new Date() } : null),
    select: (t) => (t === 'participants' ? [{ id: 'gone' }] : []),
  })
  const res = await app.inject({
    method: 'POST', url: '/api/races/r1/assign-gun-start', payload: { participantIds: ['gone', 'ok'] },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().data, { assigned: 1, skipped: ['gone'] })
  const written = log.inserted.filter((i) => i.table === 'results').map((i) => i.values.participantId)
  assert.deepEqual(written, ['ok'])
})
