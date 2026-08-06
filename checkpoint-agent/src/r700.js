import { Agent, fetch as undiciFetch } from 'undici'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PRESET = require('./inventory-preset.json')

// R700 ships a self-signed cert — skip verification (same as backend reader route)
const tlsAgent = new Agent({ connect: { rejectUnauthorized: false } })

export function normalizeReaderBase(addr) {
  const trimmed = addr.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '')
  return `https://${trimmed.replace(/\/+$/, '')}`
}

// timeoutMs default matches config.js's READER_TIMEOUT_MS default (15000) so
// direct callers (tests, scripts) that don't pass one still get the
// mDNS-cold-start-tolerant value rather than the old 5s.
export function createR700({ address, username = 'root', password = '', fetchImpl, timeoutMs = 15000 }) {
  const base = normalizeReaderBase(address)
  const doFetch = fetchImpl ?? ((url, opts) => undiciFetch(url, { ...opts, dispatcher: tlsAgent }))

  async function request(method, path, body) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
    }
    const opts = { method, headers, signal: AbortSignal.timeout(timeoutMs) }
    if (body !== undefined) opts.body = JSON.stringify(body)
    const res = await doFetch(`${base}/api/v1${path}`, opts)
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { data = { raw: text } }
    if (!res.ok) throw new Error(`R700 HTTP ${res.status}: ${JSON.stringify(data)}`)
    return data
  }

  // The R700 keeps its inventory preset running in its own firmware, even
  // across agent restarts. A running preset can't be modified (PUT → 409
  // "The preset is running") or re-started, so we stop it first, best-effort
  // (nothing running / already stopped → ignore).
  async function stopQuietly() {
    try { await request('POST', '/profiles/stop', {}) } catch { /* not running */ }
  }

  return {
    getStatus: () => request('GET', '/status'),
    async configure({ mqttHost, topic, clientId }) {
      await request('PUT', '/mqtt', {
        brokerHostname: mqttHost,
        brokerPort: 1883,
        clientId,
        eventTopic: topic,
        active: true,
        tlsEnabled: false,
        cleanSession: false,
        eventQualityOfService: 1,
        keepAliveIntervalSeconds: 60,
      })
      await stopQuietly()
      await request('PUT', '/profiles/inventory/presets/leszyrun', PRESET)
    },
    async start() {
      await stopQuietly()
      await request('PUT', '/profiles/inventory/presets/leszyrun', PRESET)
      await request('POST', '/profiles/inventory/presets/leszyrun/start', {})
    },
    stop: () => request('POST', '/profiles/stop', {}),
  }
}
