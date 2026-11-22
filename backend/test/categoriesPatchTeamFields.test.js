// PATCH /api/categories/:id: teamLapSource is no longer accepted. A relay in any order always
// counts laps from the baton; the field is ignored like any other unknown field.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { categoriesRoutes } from '../src/routes/categories.js'

const CAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

async function appFor({ category = { id: CAT, teamMode: 'relay_free', teamLapSource: 'runner' } } = {}) {
  const log = { updated: [], lookups: 0 }
  const db = {
    query: {
      categories: { findFirst: async () => { log.lookups++; return category } },
      raceRuns: { findFirst: async () => { log.lookups++; return { id: 'rr1', status: 'active' } } },
    },
    update: () => {
      const c = {}
      c.set = (v) => { log.updated.push(v); c.v = v; return c }
      c.where = () => c
      c.returning = async () => (category ? [{ ...category, ...c.v }] : [])
      return c
    },
  }
  const app = Fastify()
  app.decorate('db', db)
  await app.register(async (api) => { await api.register(categoriesRoutes) }, { prefix: '/api' })
  return { app, log }
}
const patch = (app, payload) => app.inject({ method: 'PATCH', url: `/api/categories/${CAT}`, payload })

test('teamLapSource is ignored, even during an active run and with any value', async () => {
  for (const teamLapSource of ['baton', 'runner', 'pigeon']) {
    const { app, log } = await appFor()
    const res = await patch(app, { name: 'Sztafeta', teamLapSource })
    assert.equal(res.statusCode, 200, teamLapSource)
    assert.deepEqual(log.updated, [{ name: 'Sztafeta' }])
    assert.equal(log.lookups, 0, 'no category or active-run lookup')
  }
})

test('the other team fields are still validated', async () => {
  const { app, log } = await appFor()
  const res = await patch(app, { teamMode: 'relay_free', teamLapCount: 0 })
  assert.equal(res.statusCode, 400)
  assert.equal(log.updated.length, 0)
  assert.equal((await patch(app, { teamMode: 'relay_free', teamLapCount: 5 })).statusCode, 200)
})
