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
  }
}
