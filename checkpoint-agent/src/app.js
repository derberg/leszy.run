import Fastify from 'fastify'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileStore } from './store.js'
import { parseTagInventory } from './parse.js'
import { Confirmer } from './confirmer.js'
import { createResolver } from './resolver.js'
import { ObservationQueue } from './queue.js'
import { Uploader } from './uploader.js'
import { createArmer } from './armer.js'
import { createHeartbeat } from './heartbeat.js'

const ARM_MODES = new Set(['race_start', 'immediate'])

// eventId/checkpointId are UUIDs in practice but flow straight into
// filesystem paths (ObservationQueue's queue-<checkpointId>.jsonl). The
// agent listens on 0.0.0.0 with no auth, so an unvalidated checkpointId is
// an unauthenticated arbitrary-path file-append primitive — reject anything
// that isn't a plain token before it's ever used.
const SAFE_ID = /^[A-Za-z0-9_-]+$/

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
    readerPollTimer: null,
    readerDown: false,
    lastReaderError: null,
    armed: false,
    ignoredReads: 0,
    armer: null,
    heartbeat: null,
  }

  // Derived status shown in the UI and reported by the heartbeat:
  //   no session          -> null
  //   session, not running -> 'configured'
  //   running, armed        -> 'listening'   (recording)
  //   running, not armed    -> 'armed_waiting' (reads are being dropped)
  function currentStatus() {
    if (!state.session) return null
    if (!state.running) return 'configured'
    return state.armed ? 'listening' : 'armed_waiting'
  }

  // A heartbeat should be visible as soon as a session exists (so
  // 'configured' shows on the admin tab before Start is ever pressed), and
  // keeps running with updated status/counts once the pipeline starts.
  // Idempotent: a no-op if one is already running.
  function ensureHeartbeat() {
    if (!state.session || state.heartbeat) return
    state.heartbeat = createHeartbeat({
      supabase,
      checkpointId: state.session.checkpointId,
      intervalMs: config.heartbeatMs,
      getStatus: () => ({
        status: currentStatus(),
        readsTotal: state.reads.total,
        queuePending: state.queue?.counts.pending ?? 0,
        unknownCount: state.resolver?.unknownList().length ?? 0,
      }),
    })
    state.heartbeat.start()
  }
  // Guards a single in-flight reader-health poll so a slow/hanging
  // getStatus()/configure()/start() call can't overlap with the next tick.
  let readerPollInFlight = false

  // Auto-recovery: while a session is running, periodically check the R700's
  // own /status. A mid-race power cycle on the reader wipes its MQTT +
  // inventory-preset config, so simply seeing it come back online is not
  // enough — it has to be reconfigured and restarted, or it silently stays
  // idle forever with no more tag reads reaching MQTT. Trigger reconfigure
  // when either the previous poll had failed (reader was unreachable) or the
  // reader reports it isn't actively running inventory.
  async function pollReaderHealth() {
    if (readerPollInFlight) return
    if (!state.running || !state.reader || !state.session) return
    readerPollInFlight = true
    try {
      const status = await state.reader.getStatus()
      const wasDown = state.readerDown
      const idle = status?.status !== 'running'
      if (wasDown || idle) {
        await state.reader.configure({ mqttHost: state.session.mqttHost ?? 'localhost', topic: config.mqttTopic, clientId: 'LeszyRunCheckpoint' })
        await state.reader.start()
      }
      state.readerDown = false
      state.lastReaderError = null
    } catch (err) {
      // getStatus failed, or the recovery attempt itself failed — either way
      // the reader isn't confirmed healthy. Record it and retry on the next
      // tick; never let a poll failure escape this loop.
      state.readerDown = true
      state.lastReaderError = err.message
    } finally {
      readerPollInFlight = false
    }
  }

  function startReaderPoll() {
    if (state.readerPollTimer) return
    state.readerPollTimer = setInterval(() => { pollReaderHealth() }, config.readerPollMs ?? 15000)
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
        readerDown: state.readerDown,
        lastReaderError: state.lastReaderError,
        noReader: !!state.session?.noReader,
        armMode: state.session?.armMode ?? null,
        armed: state.armed,
        ignoredReads: state.ignoredReads,
        status: currentStatus(),
      },
    }
  })

  app.get('/api/events', async (req, reply) => {
    // Only upcoming events (date >= today, Europe/Warsaw). `date` is a text
    // column in YYYY-MM-DD, so a lexicographic gte matches chronologically.
    // Nearest-first ordering suits a checkpoint operator picking today's race.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' })
    const { data, error } = await supabase.from('events').select('id, name, date').gte('date', today).order('date', { ascending: true }).limit(50)
    if (error) return reply.code(502).send({ error: error.message })
    return { data }
  })

  app.get('/api/events/:eventId/checkpoints', async (req, reply) => {
    const { data, error } = await supabase.from('checkpoints').select('id, name, km_marker').eq('event_id', req.params.eventId).order('km_marker', { ascending: true })
    if (error) return reply.code(502).send({ error: error.message })
    return { data }
  })

  app.post('/api/setup', async (req, reply) => {
    const { eventId, eventName, checkpointId, checkpointName, pin, readerIp, readerUsername, readerPassword, mqttHost, noReader, armMode } = req.body ?? {}
    // Test mode without a reader: the operator can run the whole
    // pipeline (MQTT/confirmer/resolver/queue/uploader) against the
    // simulator (scripts/simulate-reads.js) with no R700 on the LAN. In
    // that mode readerIp isn't required and, if supplied anyway, is
    // stored but never used.
    if (!eventId || !checkpointId || !pin || (!readerIp && !noReader)) {
      return reply.code(400).send({ error: 'eventId, checkpointId, pin and readerIp are required' })
    }
    if (!SAFE_ID.test(eventId) || !SAFE_ID.test(checkpointId)) {
      return reply.code(400).send({ error: 'Invalid eventId or checkpointId' })
    }
    if (armMode !== undefined && !ARM_MODES.has(armMode)) {
      return reply.code(400).send({ error: "armMode must be 'race_start' or 'immediate'" })
    }
    const result = await fetchRoster({ eventId, pin })
    if (!result.ok) return reply.code(result.status ?? 502).send({ error: result.error })
    // The R700 must reach the Pi's broker over the LAN — 'localhost' only
    // resolves from the Pi itself. Default to the detected LAN IP when the
    // operator didn't provide one explicitly.
    const resolvedMqttHost = mqttHost ?? detectLanIp() ?? 'localhost'
    state.session = {
      eventId, eventName, checkpointId, checkpointName, readerIp,
      readerUsername: readerUsername ?? 'root', readerPassword: readerPassword ?? '',
      mqttHost: resolvedMqttHost, noReader: !!noReader,
      armMode: armMode ?? 'race_start', armed: false,
      running: false,
    }
    state.armed = false
    await store.save('session', state.session)
    await store.save('roster', result.roster)
    ensureHeartbeat() // 'configured' shows on the admin tab even before Start
    return { data: { rosterCount: result.roster.length } }
  })

  async function startPipeline() {
    const roster = (await store.load('roster')) ?? []
    state.resolver = createResolver(roster)
    // Scope queue files per checkpoint so Confirmer.seed(queue.epcs()) below
    // only blacklists EPCs already recorded for THIS checkpoint session — not
    // every EPC the device has ever seen across every event/checkpoint it's
    // ever worked. Old checkpoints' files stay on disk (audit trail); a new
    // checkpoint session always starts with a clean seed.
    state.queue = new ObservationQueue(config.dataDir, state.session.checkpointId)
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

    // Arm-at-start: 'immediate' arms right away (testing / events not
    // formally started via the admin UI); 'race_start' stays disarmed until
    // the armer observes an active/finished race_run for this event, unless
    // a prior run already persisted armed:true (reboot mid-race must not
    // re-disarm and start dropping real reads).
    state.armed = state.session.armMode === 'immediate' || !!state.session.armed
    if (state.armed && !state.session.armed) {
      state.session.armed = true
      await store.save('session', state.session)
    }
    if (!state.armed && state.session.armMode === 'race_start') {
      state.armer = createArmer({ supabase, eventId: state.session.eventId, pollMs: config.armPollMs })
      state.armer.start(async () => {
        state.armed = true
        state.session.armed = true
        await store.save('session', state.session)
        app.log?.info?.('[armer] race started — armed')
      })
    }
    ensureHeartbeat()

    state.mqttClient = connectMqtt(config.mqttUrl)
    state.mqttClient.on('message', (topic, payload) => {
      const read = parseTagInventory(payload)
      if (!read) return
      state.reads.total += 1
      state.reads.lastAt = new Date().toISOString()
      if (!state.armed) {
        // Disarmed: drop the read entirely. It must never reach the
        // confirmer — feeding it would poison the one-pass-per-EPC `seen`
        // set with a pre-race false read and permanently block the
        // runner's real pass at this checkpoint.
        state.ignoredReads += 1
        return
      }
      state.confirmer.read({ ...read, at: Date.now() })
    })
    state.mqttClient.subscribe([`${config.mqttTopic}`, `${config.mqttTopic}/#`], { qos: 1 })
    state.running = true
    if (!state.session.noReader) startReaderPoll()
  }

  app.post('/api/start', async (req, reply) => {
    if (!state.session) return reply.code(409).send({ error: 'Not configured — run setup first' })
    if (state.running) return reply.code(409).send({ error: 'Already running' })
    const clock = await clockStatus()
    if (clock.synced === false && !req.body?.overrideClock) {
      return reply.code(423).send({ error: 'Clock not synchronized' })
    }
    if (!state.session.noReader) {
      state.reader = createReader({ address: state.session.readerIp, username: state.session.readerUsername, password: state.session.readerPassword })
      await state.reader.configure({ mqttHost: state.session.mqttHost ?? 'localhost', topic: config.mqttTopic, clientId: 'LeszyRunCheckpoint' })
      await state.reader.start()
    }
    await startPipeline()
    state.session.running = true
    await store.save('session', state.session)
    return { data: { ok: true } }
  })

  async function stopAll() {
    if (state.readerPollTimer) { clearInterval(state.readerPollTimer); state.readerPollTimer = null }
    if (state.reader) await state.reader.stop().catch(() => {})
    state.mqttClient?.end()
    state.confirmer?.stop()
    state.uploader?.stop()
    // Simple, correct choice: stop the heartbeat on stopAll() rather than
    // keeping a 'configured' heartbeat alive after Stop. The row simply goes
    // stale (UI derives offline from last_seen_at) until the operator either
    // Starts again (heartbeat restarts via ensureHeartbeat() in
    // startPipeline) or re-runs setup. Avoids a heartbeat instance quietly
    // outliving the pipeline it's supposed to describe.
    state.armer?.stop()
    state.armer = null
    state.heartbeat?.stop()
    state.heartbeat = null
    state.running = false
    state.readerDown = false
    state.lastReaderError = null
  }

  app.post('/api/stop', async () => {
    await stopAll()
    if (state.session) { state.session.running = false; await store.save('session', state.session) }
    return { data: { ok: true } }
  })

  app.post('/api/reset', async () => {
    await stopAll()
    state.session = null
    state.queue = null
    state.confirmer = null
    state.resolver = null
    state.uploader = null
    state.reads = { total: 0, lastAt: null }
    state.armed = false
    state.ignoredReads = 0
    await store.remove('session')
    await store.remove('roster')
    return { data: { ok: true } }
  })

  app.get('/api/reader/status', async (req, reply) => {
    if (!state.session) return reply.code(409).send({ error: 'Not configured' })
    if (state.session.noReader) return { data: { simulated: true } }
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
      if (!state.session.noReader) {
        try {
          state.reader = createReader({ address: state.session.readerIp, username: state.session.readerUsername, password: state.session.readerPassword })
          await state.reader.configure({ mqttHost: state.session.mqttHost ?? 'localhost', topic: config.mqttTopic, clientId: 'LeszyRunCheckpoint' })
          await state.reader.start()
        } catch { /* reader down — pipeline still records if reader reappears with old config */ }
      }
      await startPipeline()
    }
  }

  // Boot-time heartbeat: a session left over from a previous run (configured
  // but never started, or started and about to be resumed above) should show
  // up on the admin tab immediately rather than waiting for the next Start.
  // Idempotent — resume()'s startPipeline() call also invokes ensureHeartbeat()
  // for the running case, this just covers the not-yet-running one too.
  if (state.session) ensureHeartbeat()

  app.deps = state // exposed for tests (live services: uploader, confirmer, queue, resolver, session, ...)
  app.addHook('onClose', () => stopAll())
  return app
}
