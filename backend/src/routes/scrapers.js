import { runPipeline } from '../scrapers/index.js'
import { enrichDistances } from '../scrapers/llmEnricher.js'

export async function scrapersRoutes(fastify) {
  fastify.post('/scrapers/run', async (request, reply) => {
    const results = await runPipeline()
    return { data: results }
  })

  fastify.post('/scrapers/enrich', async (request, reply) => {
    const results = await enrichDistances()
    return { data: results }
  })
}
