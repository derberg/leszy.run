const ARM_MODES = new Set(['race_start', 'immediate'])

function truthy(v) {
  return v === 'true' || v === '1'
}

// Headless auto-config: lets a checkpoint Pi boot straight into a running
// session with no wizard, driven entirely by env vars (systemd
// EnvironmentFile). "present" gates whether app.bootstrapFromEnv() acts at
// all — eventId + checkpointId + pin are always required, and readerIp is
// required too unless noReader test mode is on.
function parseAutoconfig(env) {
  const eventId = env.AUTOCONFIG_EVENT_ID ?? null
  const checkpointId = env.AUTOCONFIG_CHECKPOINT_ID ?? null
  const pin = env.AUTOCONFIG_PIN ?? null
  const readerIp = env.AUTOCONFIG_READER_IP ?? null
  const noReader = truthy(env.AUTOCONFIG_NO_READER ?? '')
  const armModeRaw = env.AUTOCONFIG_ARM_MODE
  const armMode = armModeRaw && ARM_MODES.has(armModeRaw) ? armModeRaw : 'race_start'
  const present = !!(eventId && checkpointId && pin && (readerIp || noReader))
  return {
    present,
    eventId,
    checkpointId,
    pin,
    readerIp,
    mqttHost: env.AUTOCONFIG_MQTT_HOST ?? null,
    readerUsername: env.AUTOCONFIG_READER_USER ?? null,
    readerPassword: env.AUTOCONFIG_READER_PASSWORD ?? null,
    armMode,
    noReader,
    eventName: env.AUTOCONFIG_EVENT_NAME ?? null,
    checkpointName: env.AUTOCONFIG_CHECKPOINT_NAME ?? null,
  }
}

export function loadConfig(env = process.env) {
  return {
    port: parseInt(env.AGENT_PORT ?? '8080', 10),
    mqttUrl: env.MQTT_URL ?? 'mqtt://localhost:1883',
    mqttTopic: env.MQTT_TOPIC ?? 'leszyrun/checkpoint',
    supabaseUrl: env.SUPABASE_URL ?? null,
    supabaseAnonKey: env.SUPABASE_ANON_KEY ?? null,
    dataDir: env.DATA_DIR ?? './data',
    goneWindowMs: parseInt(env.GONE_WINDOW_MS ?? '3000', 10),
    uploadIntervalMs: parseInt(env.UPLOAD_INTERVAL_MS ?? '5000', 10),
    readerPollMs: parseInt(env.READER_POLL_MS ?? '15000', 10),
    // The R700 is addressed by mDNS hostname (impinj-XX-XX-XX.local) in the
    // field. On a cold start, mDNS resolution + the reader's first HTTP
    // response can take well over a few seconds — a too-short timeout here
    // makes configure()/start() throw "aborted due to timeout" on the very
    // first call after boot. 15s gives mDNS resolution room without hanging
    // forever on a genuinely dead reader.
    readerTimeoutMs: parseInt(env.READER_TIMEOUT_MS ?? '15000', 10),
    // 3s, not 15s. Reads taken while disarmed are DROPPED, so this interval is
    // also the size of the window in which a checkpoint pass is silently lost
    // after the gun. Measured 2026-08-07: race started 15:36:55, the agent armed
    // 15:37:15 (20 s later), 830 reads were dropped and only 10 of 20 runners
    // were recorded — the whole first wave. Irrelevant on a real course, where a
    // mid-race checkpoint is minutes away, but fatal on a short lap and on any
    // checkpoint sited near the start.
    //
    // NOTE: 3s shrinks the window ~5x, it does not close it. Closing it needs the
    // agent to buffer pre-arm reads and replay the ones timestamped after the
    // race start (deliberately not done here — pre-gun reads must keep being
    // dropped, see the UNIQUE(checkpoint_id, bib_number) slot-burning problem).
    armPollMs: parseInt(env.ARM_POLL_MS ?? '3000', 10),
    heartbeatMs: parseInt(env.HEARTBEAT_MS ?? '15000', 10),
    autoconfig: parseAutoconfig(env),
  }
}
