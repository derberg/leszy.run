import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReaderBase, createR700 } from '../src/r700.js'

test('normalizeReaderBase handles bare IP, hostname, https URL, trailing slash', () => {
  assert.equal(normalizeReaderBase('192.168.1.50'), 'https://192.168.1.50')
  assert.equal(normalizeReaderBase('impinj-xx.local/'), 'https://impinj-xx.local')
  assert.equal(normalizeReaderBase('https://impinj-xx.local/'), 'https://impinj-xx.local')
})

function capture(responses = {}) {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined, headers: opts.headers })
    return { ok: true, text: async () => JSON.stringify(responses[url] ?? { ok: true }) }
  }
  return { calls, fetchImpl }
}

test('configure pushes MQTT config then preset', async () => {
  const { calls, fetchImpl } = capture()
  const r = createR700({ address: '10.0.0.5', username: 'root', password: 'pw', fetchImpl })
  await r.configure({ mqttHost: '10.0.0.1', topic: 'leszyrun/checkpoint', clientId: 'LeszyRunCheckpoint' })
  assert.equal(calls[0].url, 'https://10.0.0.5/api/v1/mqtt')
  assert.equal(calls[0].method, 'PUT')
  assert.deepEqual(calls[0].body, {
    brokerHostname: '10.0.0.1', brokerPort: 1883, clientId: 'LeszyRunCheckpoint',
    eventTopic: 'leszyrun/checkpoint', active: true, tlsEnabled: false,
    cleanSession: false, eventQualityOfService: 1, keepAliveIntervalSeconds: 60,
  })
  assert.equal(calls[1].url, 'https://10.0.0.5/api/v1/profiles/inventory/presets/leszyrun')
  assert.match(calls[0].headers.Authorization, /^Basic /)
})

test('start uploads preset then starts; stop calls profiles/stop', async () => {
  const { calls, fetchImpl } = capture()
  const r = createR700({ address: '10.0.0.5', username: 'root', password: '', fetchImpl })
  await r.start()
  assert.equal(calls[0].url, 'https://10.0.0.5/api/v1/profiles/inventory/presets/leszyrun')
  assert.equal(calls[1].url, 'https://10.0.0.5/api/v1/profiles/inventory/presets/leszyrun/start')
  await r.stop()
  assert.equal(calls[2].url, 'https://10.0.0.5/api/v1/profiles/stop')
})

test('non-ok response throws readable error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => '{"message":"unauthorized"}' })
  const r = createR700({ address: '10.0.0.5', username: 'root', password: 'x', fetchImpl })
  await assert.rejects(() => r.getStatus(), /R700 HTTP 401/)
})
