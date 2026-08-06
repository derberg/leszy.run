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
    // Live "raw reads" ring buffer for the dashboard — newest first, capped
    // at 30. Populated for EVERY parsed read regardless of arm state, so an
    // operator can see the antenna->R700->MQTT->agent chain working even
    // while disarmed (pre-race) or for tags not on the roster. This is
    // display-only and never feeds the confirmer/queue.
    recentReads: [],
    readerPollTimer: null,
    readerDown: false,
    lastReaderError: null,
    armed: false,
    ignoredReads: 0,
    armer: null,
    heartbeat: null,
    heartbeatCheckpointId: null,
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
  // Idempotent: a no-op if one is already running AND still bound to the
  // current session's checkpointId. If /api/setup is re-run for a DIFFERENT
  // checkpoint, the old heartbeat (its checkpointId baked into the closure
  // createHeartbeat() was built with) must be stopped and replaced — otherwise
  // it keeps upserting status rows under the OLD checkpoint_id forever while
  // the new checkpoint never gets a heartbeat of its own.
  function ensureHeartbeat() {
    if (!state.session) return
    if (state.heartbeat && state.heartbeatCheckpointId === state.session.checkpointId) return
    state.heartbeat?.stop()
    state.heartbeatCheckpointId = state.session.checkpointId
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
        recentReads: state.recentReads,
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

  // Shared by POST /api/setup and bootstrapFromEnv() so headless auto-config
  // exercises exactly the same validation + persistence path as the wizard —
  // no duplicated logic to drift out of sync.
  async function doSetup({ eventId, eventName, checkpointId, checkpointName, pin, readerIp, readerUsername, readerPassword, mqttHost, noReader, armMode }) {
    // Test mode without a reader: the operator can run the whole
    // pipeline (MQTT/confirmer/resolver/queue/uploader) against the
    // simulator (scripts/simulate-reads.js) with no R700 on the LAN. In
    // that mode readerIp isn't required and, if supplied anyway, is
    // stored but never used.
    if (!eventId || !checkpointId || !pin || (!readerIp && !noReader)) {
      return { ok: false, status: 400, error: 'eventId, checkpointId, pin and readerIp are required' }
    }
    if (!SAFE_ID.test(eventId) || !SAFE_ID.test(checkpointId)) {
      return { ok: false, status: 400, error: 'Invalid eventId or checkpointId' }
    }
    if (armMode !== undefined && !ARM_MODES.has(armMode)) {
      return { ok: false, status: 400, error: "armMode must be 'race_start' or 'immediate'" }
    }
    const result = await fetchRoster({ eventId, pin })
    if (!result.ok) return { ok: false, status: result.status ?? 502, error: result.error }
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
    return { ok: true, rosterCount: result.roster.length }
  }

  app.post('/api/setup', async (req, reply) => {
    const result = await doSetup(req.body ?? {})
    if (!result.ok) return reply.code(result.status).send({ error: result.error })
    return { data: { rosterCount: result.rosterCount } }
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
        state.queue.append({ epc, checkpoint_id: state.session.checkpointId, bib_number: bib, observed_at: new Date(peakTime).toISOString(), source: 'rfid' })
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
      // Record into the display-only ring buffer for EVERY parsed read,
      // regardless of arm state — this is the whole point of the raw-reads
      // feed (see comment on state.recentReads above). Never touches the
      // confirmer/queue gating below.
      state.recentReads.unshift({
        epc: read.epc,
        rssiCdbm: read.rssiCdbm,
        antennaPort: read.antennaPort,
        at: new Date().toISOString(),
        bib: state.resolver?.lookup(read.epc) ?? null,
        armed: !!state.armed,
      })
      if (state.recentReads.length > 30) state.recentReads.length = 30
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

  // Shared by POST /api/start and bootstrapFromEnv().
  async function doStart({ overrideClock } = {}) {
    if (!state.session) return { ok: false, status: 409, error: 'Not configured — run setup first' }
    if (state.running) return { ok: false, status: 409, error: 'Already running' }
    const clock = await clockStatus()
    if (clock.synced === false && !overrideClock) {
      return { ok: false, status: 423, error: 'Clock not synchronized' }
    }
    if (!state.session.noReader) {
      state.reader = createReader({ address: state.session.readerIp, username: state.session.readerUsername, password: state.session.readerPassword, timeoutMs: config.readerTimeoutMs })
      // Reader-start is NON-FATAL: on a cold R700 (mDNS hostname resolution +
      // the reader's first HTTPS response) even a generous timeout can still
      // occasionally be exceeded, and a hardware fault can leave it
      // unreachable for longer than that. Either way, failing here must not
      // abort the whole start — the pipeline still comes up (MQTT,
      // confirmer, uploader, heartbeat, and pollReaderHealth), and
      // pollReaderHealth already knows how to reconfigure+restart the reader
      // once it responds (see the "wasDown || idle" branch below). Without
      // this, a slow cold start left the agent configured-but-not-running
      // with no automatic retry until a human intervened.
      try {
        await state.reader.configure({ mqttHost: state.session.mqttHost ?? 'localhost', topic: config.mqttTopic, clientId: 'LeszyRunCheckpoint' })
        await state.reader.start()
      } catch (err) {
        console.error(`[reader] initial configure failed, health poll will retry: ${err.message}`)
        state.readerDown = true
        state.lastReaderError = err.message
      }
    }
    await startPipeline()
    state.session.running = true
    await store.save('session', state.session)
    return { ok: true }
  }

  app.post('/api/start', async (req, reply) => {
    const result = await doStart({ overrideClock: req.body?.overrideClock })
    if (!result.ok) return reply.code(result.status).send({ error: result.error })
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
    state.recentReads = []
    state.armed = false
    state.ignoredReads = 0
    state.heartbeatCheckpointId = null
    await store.remove('session')
    await store.remove('roster')
    return { data: { ok: true } }
  })

  app.get('/api/reader/status', async (req, reply) => {
    if (!state.session) return reply.code(409).send({ error: 'Not configured' })
    if (state.session.noReader) return { data: { simulated: true } }
    try {
      const reader = state.reader ?? createReader({ address: state.session.readerIp, username: state.session.readerUsername, password: state.session.readerPassword, timeoutMs: config.readerTimeoutMs })
      return { data: await reader.getStatus() }
    } catch (err) {
      return reply.code(502).send({ error: err.message })
    }
  })

  // auto-resume after reboot/crash
  app.resume = async () => {
    if (state.session?.running) {
      if (!state.session.noReader) {
        state.reader = createReader({ address: state.session.readerIp, username: state.session.readerUsername, password: state.session.readerPassword, timeoutMs: config.readerTimeoutMs })
        try {
          await state.reader.configure({ mqttHost: state.session.mqttHost ?? 'localhost', topic: config.mqttTopic, clientId: 'LeszyRunCheckpoint' })
          await state.reader.start()
        } catch (err) {
          // reader down — pipeline still records if reader reappears with old
          // config; pollReaderHealth (started by startPipeline() below) will
          // reconfigure+restart it once it responds.
          console.error(`[reader] initial configure failed, health poll will retry: ${err.message}`)
          state.readerDown = true
          state.lastReaderError = err.message
        }
      }
      await startPipeline()
    }
  }

  // Headless auto-config: lets a checkpoint Pi boot straight into a running
  // session with no operator ever touching the wizard, driven entirely by
  // AUTOCONFIG_* env vars (see config.js). AUTOCONFIG is authoritative: when
  // it's present, index.js calls this INSTEAD of app.resume() — never after
  // it — so a stale persisted session (possibly for a different reader IP,
  // event, or checkpoint) never gets to start running before this runs. That
  // ordering is what lets the guard below stay simple: at boot, with
  // resume() skipped, nothing is running yet, so this always proceeds and
  // (re)configures from the env. The guard still matters at runtime — it
  // stops this from being re-entered while a pipeline is already live (e.g.
  // if something ever calls it a second time after resume() legitimately
  // started a non-autoconfig session). Never throws — a bad PIN, an
  // unreachable reader, or invalid ids must leave the server up and
  // reachable so the operator can fall back to the UI, not crash the
  // process.
  app.bootstrapFromEnv = async () => {
    const ac = config.autoconfig
    if (!ac?.present) return
    // Idempotent, and deliberately checkpoint-agnostic: if ANYTHING is
    // already running — this checkpoint or a different one — bootstrapping
    // must be a hard no-op. Comparing checkpointId first and only guarding
    // on a match is wrong: doSetup() below persists state.session (pointing
    // it at the NEW checkpoint) before doStart() would reject with 409,
    // leaving the on-disk session pointing at the new checkpoint while the
    // live pipeline/queue/heartbeat are still running under the old one.
    if (state.running) {
      console.log('[autoconfig] a session is already running — leaving it; stop it first to reconfigure')
      return
    }
    const uiPort = config.port ?? 8080
    try {
      const setupResult = await doSetup({
        eventId: ac.eventId,
        eventName: ac.eventName,
        checkpointId: ac.checkpointId,
        checkpointName: ac.checkpointName,
        pin: ac.pin,
        readerIp: ac.readerIp,
        readerUsername: ac.readerUsername,
        readerPassword: ac.readerPassword,
        mqttHost: ac.mqttHost,
        noReader: ac.noReader,
        armMode: ac.armMode,
      })
      if (!setupResult.ok) {
        console.error(`[autoconfig] failed: ${setupResult.error} — configure via the UI at :${uiPort}`)
        return
      }
      const startResult = await doStart({})
      if (!startResult.ok) {
        console.error(`[autoconfig] failed: ${startResult.error} — configure via the UI at :${uiPort}`)
        return
      }
      console.log(`[autoconfig] configured checkpoint ${ac.checkpointId} for event ${ac.eventId}, armMode=${ac.armMode}, status=${currentStatus()}`)
    } catch (err) {
      console.error(`[autoconfig] failed: ${err.message} — configure via the UI at :${uiPort}`)
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
