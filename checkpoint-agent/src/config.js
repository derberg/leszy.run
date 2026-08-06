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
    armPollMs: parseInt(env.ARM_POLL_MS ?? '15000', 10),
    heartbeatMs: parseInt(env.HEARTBEAT_MS ?? '15000', 10),
    autoconfig: parseAutoconfig(env),
  }
}
