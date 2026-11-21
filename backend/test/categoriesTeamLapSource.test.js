// PATCH /api/categories/:id teamLapSource: only on a relay in any order, never while it runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { categoriesRoutes } from '../src/routes/categories.js'

const CAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

async function appFor({ category = { id: CAT, teamMode: 'relay_free', teamLapSource: 'runner' }, activeRun = null } = {}) {
  const log = { updated: [] }
  const db = {
    query: {
      categories: { findFirst: async () => category },
      raceRuns: { findFirst: async () => activeRun },
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

test('switches a relay in any order to baton laps when no run is active', async () => {
  const { app, log } = await appFor()
  const res = await patch(app, { teamLapSource: 'baton' })
  assert.equal(res.statusCode, 200)
  assert.equal(log.updated[0].teamLapSource, 'baton')
})

test('refuses the switch while the category has an active race run', async () => {
  const { app, log } = await appFor({ activeRun: { id: 'rr1', status: 'active' } })
  const res = await patch(app, { teamLapSource: 'baton' })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error, 'Nie można zmienić sposobu liczenia w trakcie biegu.')
  assert.equal(log.updated.length, 0)
})

test('re-sending the current source during a run is no change and passes', async () => {
  const { app } = await appFor({ activeRun: { id: 'rr1', status: 'active' } })
  assert.equal((await patch(app, { teamLapSource: 'runner' })).statusCode, 200)
})

test('refuses teamLapSource on a category that is no relay in any order', async () => {
  for (const teamMode of [null, 'relay']) {
    const { app, log } = await appFor({ category: { id: CAT, teamMode, teamLapSource: 'runner' } })
    const res = await patch(app, { teamLapSource: 'baton' })
    assert.equal(res.statusCode, 422, `teamMode ${teamMode}`)
    assert.equal(log.updated.length, 0)
  }
})

test('teamMode switched to relay_free in the same PATCH allows the source', async () => {
  const { app } = await appFor({ category: { id: CAT, teamMode: null, teamLapSource: 'runner' } })
  assert.equal((await patch(app, { teamMode: 'relay_free', teamLapSource: 'baton' })).statusCode, 200)
})

test('an unknown source is a 400 in operator Polish, and a missing category a 404', async () => {
  const { app } = await appFor()
  const res = await patch(app, { teamLapSource: 'pigeon' })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, 'Nieprawidłowy sposób liczenia okrążeń.')
  const missing = await appFor({ category: null })
  assert.equal((await patch(missing.app, { teamLapSource: 'baton' })).statusCode, 404)
})

test('a PATCH without teamLapSource is untouched by these rules', async () => {
  const { app } = await appFor({ category: { id: CAT, teamMode: null }, activeRun: { id: 'rr1' } })
  assert.equal((await patch(app, { name: 'Nowa' })).statusCode, 200)
})
