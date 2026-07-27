import { createClient } from '@supabase/supabase-js'
import mqtt from 'mqtt'
import { loadConfig } from './config.js'
import { buildApp } from './app.js'
import { createR700 } from './r700.js'
import { clockStatus, detectLanIp } from './clock.js'

const config = loadConfig()
if (!config.supabaseUrl || !config.supabaseAnonKey) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required')
  process.exit(1)
}
const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey)

async function fetchRoster({ eventId, pin }) {
  try {
    const res = await fetch(`${config.supabaseUrl}/functions/v1/checkpoint-roster`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.supabaseAnonKey}`, apikey: config.supabaseAnonKey },
      body: JSON.stringify({ event_id: eventId, pin }),
    })
    const body = await res.json()
    if (!res.ok) return { ok: false, status: res.status, error: body.error ?? 'Roster download failed' }
    return { ok: true, roster: body.data }
  } catch (err) {
    return { ok: false, status: 502, error: `Roster download failed: ${err.message}` }
  }
}

const app = await buildApp({
  config,
  supabase,
  fetchRoster,
  createReader: createR700,
  connectMqtt: (url) => mqtt.connect(url, { clientId: 'checkpoint-agent', reconnectPeriod: 3000 }),
  clockStatus,
  detectLanIp,
})

await app.resume()
await app.listen({ port: config.port, host: '0.0.0.0' })
const lanIp = detectLanIp()
console.log(`[agent] listening on http://${lanIp ?? 'localhost'}:${config.port}`)
