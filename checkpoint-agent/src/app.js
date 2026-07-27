import Fastify from 'fastify'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileStore } from './store.js'
import { parseTagInventory } from './parse.js'
import { Confirmer } from './confirmer.js'
import { createResolver } from './resolver.js'
import { ObservationQueue } from './queue.js'
import { Uploader } from './uploader.js'

// Fastify app factory — dependency-injected so tests can stub every side
// effect (Supabase, MQTT, the R700 reader, roster download, clock check,
// LAN IP detection). See task-10-brief.md for the endpoint contract.
export async function buildApp({ config, supabase, fetchRoster, createReader, connectMqtt, clockStatus, detectLanIp }) {
  const app = Fastify({ logger: false })
  const store = new FileStore(config.dataDir)

  const state = {
    session: await store.load('session'),
    running: false,
    reader: null,
    mqttClient: null,
    confirmer: null,
    resolver: null,
    queue: null,
    uploader: null,
    reads: { total: 0, lastAt: null },
  }

  // ---- static UI (built by task 11; absent in tests — register conditionally)
  const uiDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'dist')
  try {
    const { access } = await import('node:fs/promises')
    await access(uiDist)
    const fastifyStatic = (await import('@fastify/static')).default
    app.register(fastifyStatic, { root: uiDist })
  } catch { /* no UI build — API only */ }

  app.get('/api/state', async () => {
    const clock = await clockStatus()
    return {
      data: {
        session: state.session,
        running: state.running,
        clock,
        counts: state.queue?.counts ?? { total: 0, pending: 0 },
        upload: state.uploader?.status ?? { lastUploadAt: null, lastError: null },
        unknown: state.resolver?.unknownList() ?? [],
        confirmedCount: state.confirmer?.confirmedCount ?? 0,
        inRangeCount: state.confirmer?.inRangeCount ?? 0,
        knownCount: state.resolver?.knownCount ?? 0,
        reads: state.reads,
      },
    }
  })

  app.get('/api/events', async (req, reply) => {
    const { data, error } = await supabase.from('events').select('id, name, date').order('date', { ascending: false }).limit(50)
    if (error) return reply.code(502).send({ error: error.message })
    return { data }
  })

  app.get('/api/events/:eventId/checkpoints', async (req, reply) => {
    const { data, error } = await supabase.from('checkpoints').select('id, name, km_marker').eq('event_id', req.params.eventId).order('km_marker', { ascending: true })
    if (error) return reply.code(502).send({ error: error.message })
    return { data }
  })

  app.post('/api/setup', async (req, reply) => {
    const { eventId, eventName, checkpointId, checkpointName, pin, readerIp, readerUsername, readerPassword, mqttHost } = req.body ?? {}
    if (!eventId || !checkpointId || !pin || !readerIp) {
      return reply.code(400).send({ error: 'eventId, checkpointId, pin and readerIp are required' })
    }
    const result = await fetchRoster({ eventId, pin })
    if (!result.ok) return reply.code(result.status ?? 502).send({ error: result.error })
    // The R700 must reach the Pi's broker over the LAN — 'localhost' only
    // resolves from the Pi itself. Default to the detected LAN IP when the
    // operator didn't provide one explicitly.
    const resolvedMqttHost = mqttHost ?? detectLanIp() ?? 'localhost'
    state.session = { eventId, eventName, checkpointId, checkpointName, readerIp, readerUsername: readerUsername ?? 'root', readerPassword: readerPassword ?? '', mqttHost: resolvedMqttHost, running: false }
    await store.save('session', state.session)
    await store.save('roster', result.roster)
    return { data: { rosterCount: result.roster.length } }
  })

  async function startPipeline() {
    const roster = (await store.load('roster')) ?? []
    state.resolver = createResolver(roster)
    state.queue = new ObservationQueue(config.dataDir)
    await state.queue.init()
    state.confirmer = new Confirmer({
      goneWindowMs: config.goneWindowMs,
      onConfirm: ({ epc, peakTime }) => {
        const bib = state.resolver.resolve(epc)
        if (bib == null) return // unknown tag — tracked by resolver, never uploaded
        state.queue.append({ epc, checkpoint_id: state.session.checkpointId, bib_number: bib, observed_at: new Date(peakTime).toISOString() })
      },
    })
    state.confirmer.seed(state.queue.epcs()) // restart recovery: don't re-record
    state.uploader = new Uploader({ queue: state.queue, supabase, intervalMs: config.uploadIntervalMs })
    state.uploader.start()
    state.mqttClient = connectMqtt(config.mqttUrl)
    state.mqttClient.on('message', (topic, payload) => {
      const read = parseTagInventory(payload)
      if (!read) return
      state.reads.total += 1
      state.reads.lastAt = new Date().toISOString()
      state.confirmer.read({ ...read, at: Date.now() })
    })
    state.mqttClient.subscribe([`${config.mqttTopic}`, `${config.mqttTopic}/#`], { qos: 1 })
    state.running = true
  }

  app.post('/api/start', async (req, reply) => {
    if (!state.session) return reply.code(409).send({ error: 'Not configured — run setup first' })
    const clock = await clockStatus()
    if (clock.synced === false && !req.body?.overrideClock) {
      return reply.code(423).send({ error: 'Clock not synchronized' })
    }
    state.reader = createReader({ address: state.session.readerIp, username: state.session.readerUsername, password: state.session.readerPassword })
    await state.reader.configure({ mqttHost: state.session.mqttHost ?? 'localhost', topic: config.mqttTopic, clientId: 'LeszyRunCheckpoint' })
    await state.reader.start()
    await startPipeline()
    state.session.running = true
    await store.save('session', state.session)
    return { data: { ok: true } }
  })

  async function stopAll() {
    if (state.reader) await state.reader.stop().catch(() => {})
    state.mqttClient?.end()
    state.confirmer?.stop()
    state.uploader?.stop()
    state.running = false
  }

  app.post('/api/stop', async () => {
    await stopAll()
    if (state.session) { state.session.running = false; await store.save('session', state.session) }
    return { data: { ok: true } }
  })

  app.post('/api/reset', async () => {
    await stopAll()
    state.session = null
    await store.remove('session')
    await store.remove('roster')
    return { data: { ok: true } }
  })

  app.get('/api/reader/status', async (req, reply) => {
    if (!state.session) return reply.code(409).send({ error: 'Not configured' })
    try {
      const reader = state.reader ?? createReader({ address: state.session.readerIp, username: state.session.readerUsername, password: state.session.readerPassword })
      return { data: await reader.getStatus() }
    } catch (err) {
      return reply.code(502).send({ error: err.message })
    }
  })

  // auto-resume after reboot/crash
  app.resume = async () => {
    if (state.session?.running) {
      try {
        state.reader = createReader({ address: state.session.readerIp, username: state.session.readerUsername, password: state.session.readerPassword })
        await state.reader.configure({ mqttHost: state.session.mqttHost ?? 'localhost', topic: config.mqttTopic, clientId: 'LeszyRunCheckpoint' })
        await state.reader.start()
      } catch { /* reader down — pipeline still records if reader reappears with old config */ }
      await startPipeline()
    }
  }

  app.deps = state // exposed for tests (live services: uploader, confirmer, queue, resolver, session, ...)
  app.addHook('onClose', () => stopAll())
  return app
}
