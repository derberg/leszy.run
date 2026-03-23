import { runPipeline } from '../scrapers/index.js'

export async function scrapersRoutes(fastify) {
  fastify.post('/scrapers/run', async (request, reply) => {
    const results = await runPipeline()
    return { data: results }
  })
}
