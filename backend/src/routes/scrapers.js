import { runPipeline } from '../scrapers/index.js'
import { enrichEvents } from '../scrapers/llmEnricher.js'
import { resolveUrls } from '../scrapers/urlResolver.js'

export async function scrapersRoutes(fastify) {
  fastify.post('/scrapers/run', async (request, reply) => {
    const results = await runPipeline()
    return { data: results }
  })

  fastify.post('/scrapers/enrich', async (request, reply) => {
    const results = await enrichEvents()
    return { data: results }
  })

  fastify.post('/scrapers/resolve-urls', async (request, reply) => {
    const results = await resolveUrls()
    return { data: results }
  })
}
