// PATCH /api/participants/:id refuses a tag that is a baton of the same event (stub db, no Postgres).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { getTableName } from 'drizzle-orm'
import { participantsRoutes } from '../src/routes/participants.js'

async function appFor({ batons = [] } = {}) {
  const log = { updates: [] }
  const db = {
    query: { participants: { findFirst: async () => ({ id: 'p1', eventId: 'e1' }) } },
    select: () => {
      const c = {}
      c.from = (t) => { c.table = getTableName(t); return c }
      c.where = () => c
      c.then = (res, rej) => Promise.resolve(c.table === 'team_batons' ? batons.map(epc => ({ epc })) : []).then(res, rej)
      return c
    },
    update: () => ({
      set: (v) => ({ where: () => ({ returning: () => { log.updates.push(v); return Promise.resolve([{ id: 'p1', ...v }]) } }) }),
    }),
  }
  const app = Fastify()
  app.decorate('db', db)
  await app.register(async (api) => { await api.register(participantsRoutes) }, { prefix: '/api' })
  return { app, log }
}
const patch = (app, body) => app.inject({ method: 'PATCH', url: '/api/participants/p1', payload: body })

test("a baton's tag is refused for a runner, writing nothing", async () => {
  const { app, log } = await appFor({ batons: ['B1'] })
  const res = await patch(app, { rfidEpc: 'b1' })
  assert.equal(res.statusCode, 422)
  assert.equal(res.json().error, 'Ten tag ma pałka drużyny.')
  assert.equal(log.updates.length, 0)
})

test('any other tag, or clearing the tag, is stored', async () => {
  const { app, log } = await appFor({ batons: ['B1'] })
  assert.equal((await patch(app, { rfidEpc: 'E1' })).statusCode, 200)
  assert.equal((await patch(app, { rfidEpc: '' })).statusCode, 200)
  assert.equal(log.updates.length, 2)
})
