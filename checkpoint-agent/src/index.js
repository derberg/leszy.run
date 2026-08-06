import { createClient } from '@supabase/supabase-js'
import mqtt from 'mqtt'
import { loadConfig } from './config.js'
import { buildApp } from './app.js'
import { createR700 } from './r700.js'
import { clockStatus, detectLanIp, listLanIpsWithIface } from './clock.js'

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

// Prints every reachable non-internal IPv4 address with its interface name
// (a checkpoint Pi commonly has two NICs: the internet-facing one the
// operator's phone/laptop is on, and a link-local USB-NIC straight to the
// R700) so the operator isn't stuck guessing which address to open. The
// IPv4/non-internal filtering itself lives once in clock.js — this just
// prints what it returns.
function printListeningAddresses(port) {
  const entries = listLanIpsWithIface()
  if (entries.length === 0) {
    console.log(`[agent] listening on http://localhost:${port}`)
    return
  }
  console.log('[agent] listening on:')
  for (const { iface, address } of entries) {
    console.log(`  http://${address}:${port}   (${iface})`)
  }
  console.log('open the one on the same network as your phone/laptop')
}

await app.resume()
await app.listen({ port: config.port, host: '0.0.0.0' })
printListeningAddresses(config.port)
// Headless auto-config (AUTOCONFIG_* env vars) — must not block the server
// from being reachable, so it runs after listen() and isn't awaited here.
// Never rejects (bootstrapFromEnv() catches everything internally); the
// .catch is just a defensive backstop against an unhandled rejection.
app.bootstrapFromEnv().catch((err) => console.error(`[autoconfig] failed: ${err.message}`))
