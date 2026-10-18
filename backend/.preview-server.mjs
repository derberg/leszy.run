// Preview of feature/vision-white-bib: serves the branch's camera routes and
// passes every other /api request to the running backend on :3001.
import http from 'node:http'
const W = '/Users/derberg/Documents/GitHub/BeepBeep/.worktrees/feature-vision-white-bib/backend'
const { default: Fastify } = await import(W + '/node_modules/fastify/fastify.js').catch(() => import('/Users/derberg/Documents/GitHub/BeepBeep/.worktrees/feature-vision-white-bib/node_modules/fastify/fastify.js'))
const { db } = await import(W + '/src/db/index.js')
const { migrate } = await import('/Users/derberg/Documents/GitHub/BeepBeep/.worktrees/feature-vision-white-bib/node_modules/drizzle-orm/postgres-js/migrator.js')
const { visionRoutes } = await import(W + '/src/routes/vision.js')
await migrate(db, { migrationsFolder: W + '/src/db/migrations' })
const app = Fastify()
app.decorate('db', db)
app.addHook('onRequest', async (req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*')
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  reply.header('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return reply.code(204).send()
})
await app.register(visionRoutes, { prefix: '/api' })
app.setNotFoundHandler((req, reply) => {
  const up = http.request({ host: 'localhost', port: 3001, path: req.url, method: req.method, headers: req.headers }, (res) => {
    reply.hijack()
    reply.raw.writeHead(res.statusCode, { ...res.headers, 'access-control-allow-origin': '*' })
    res.pipe(reply.raw)
  })
  up.on('error', (e) => reply.code(502).send({ error: e.message }))
  if (req.body) up.end(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
  else up.end()
})
await app.listen({ port: 3011, host: '127.0.0.1' })
console.log('preview api on :3011')
