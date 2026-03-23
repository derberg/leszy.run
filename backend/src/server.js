import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createServer } from 'http'

import { db } from './db/index.js'
import { initWebSocket } from './ws/broadcaster.js'
import { initMqtt } from './mqtt/client.js'
import { initSupabaseSync } from './sync/supabase.js'
import { initCheckinSync } from './sync/checkinSync.js'

import { eventsRoutes } from './routes/events.js'
import { categoriesRoutes } from './routes/categories.js'
import { participantsRoutes } from './routes/participants.js'
import { racesRoutes } from './routes/races.js'
import { resultsRoutes } from './routes/results.js'
import { rfidRoutes } from './routes/rfid.js'
import { readerRoutes } from './routes/reader.js'
import { checkpointsRoutes } from './routes/checkpoints.js'
import { smsRoutes } from './routes/sms.js'
import { eventDocumentsRoutes } from './routes/eventDocuments.js'
import { eventSecretsRoutes } from './routes/eventSecrets.js'
import { scrapersRoutes } from './routes/scrapers.js'
import { calendarEventsRoutes } from './routes/calendarEvents.js'
import { urlSuggestionsRoutes } from './routes/urlSuggestions.js'
import cron from 'node-cron'
import { runPipeline } from './scrapers/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const fastify = Fastify({ logger: { level: 'warn' } })

// Expose db on fastify instance for routes
fastify.decorate('db', db)

await fastify.register(cors, { origin: true })
await fastify.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } })

// Register all API routes under /api prefix
await fastify.register(async (api) => {
  api.decorate('db', db)
  await api.register(eventsRoutes)
  await api.register(categoriesRoutes)
  await api.register(participantsRoutes)
  await api.register(racesRoutes)
  await api.register(resultsRoutes)
  await api.register(rfidRoutes)
  await api.register(readerRoutes)
  await api.register(checkpointsRoutes)
  await api.register(smsRoutes)
  await api.register(eventDocumentsRoutes)
  await api.register(eventSecretsRoutes)
  await api.register(scrapersRoutes)
  await api.register(calendarEventsRoutes)
  await api.register(urlSuggestionsRoutes)
}, { prefix: '/api' })

// Health check
fastify.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }))

const start = async () => {
  try {
    // Run DB migrations
    console.log('[DB] Running migrations...')
    await migrate(db, { migrationsFolder: join(__dirname, 'db/migrations') })
    console.log('[DB] Migrations complete')

    // Build underlying HTTP server so we can attach WebSocket
    const address = await fastify.listen({
      port: parseInt(process.env.PORT || '3001'),
      host: '0.0.0.0',
    })

    // Attach WebSocket to same HTTP server
    initWebSocket(fastify.server)

    // Connect MQTT (creates the CrossingDetector instance)
    initMqtt(db)

    // On startup, reload any active races into the crossing detector
    // MUST happen after initMqtt so detector instance exists
    await reloadActiveRaces()

    // Start Supabase sync
    initSupabaseSync(db)
    initCheckinSync(db)

    cron.schedule('0 3 * * *', () => {
      console.log('[cron] Starting daily scrape...')
      runPipeline().catch(err => console.error('[cron] Scrape failed:', err))
    })

    console.log(`[Server] LeszyRun backend running at ${address}`)
  } catch (err) {
    console.error('[Server] Startup error:', err)
    process.exit(1)
  }
}

async function reloadActiveRaces() {
  const { eq } = await import('drizzle-orm')
  const { raceRuns, participants, categories, events } = await import('./db/schema.js')
  const { getDetector } = await import('./mqtt/client.js')

  const activeRuns = await db.query.raceRuns.findMany({
    where: eq(raceRuns.status, 'active'),
    with: {
      category: {
        with: {
          event: true,
          participants: true,
        },
      },
    },
  })

  const detector = getDetector()
  if (!detector || !activeRuns.length) return

  for (const run of activeRuns) {
    await detector.startRace(run, run.category.event, run.category.participants)
  }
  console.log(`[Server] Reloaded ${activeRuns.length} active race(s) into detector`)
}

start()
