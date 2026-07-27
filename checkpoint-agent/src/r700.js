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

export function createR700({ address, username = 'root', password = '', fetchImpl }) {
  const base = normalizeReaderBase(address)
  const doFetch = fetchImpl ?? ((url, opts) => undiciFetch(url, { ...opts, dispatcher: tlsAgent }))

  async function request(method, path, body) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
    }
    const opts = { method, headers, signal: AbortSignal.timeout(5000) }
    if (body !== undefined) opts.body = JSON.stringify(body)
    const res = await doFetch(`${base}/api/v1${path}`, opts)
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { data = { raw: text } }
    if (!res.ok) throw new Error(`R700 HTTP ${res.status}: ${JSON.stringify(data)}`)
    return data
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
      await request('PUT', '/profiles/inventory/presets/leszyrun', PRESET)
    },
    async start() {
      await request('PUT', '/profiles/inventory/presets/leszyrun', PRESET)
      await request('POST', '/profiles/inventory/presets/leszyrun/start', {})
    },
    stop: () => request('POST', '/profiles/stop', {}),
  }
}
