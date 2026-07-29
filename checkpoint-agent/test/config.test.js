import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'

test('defaults', () => {
  const c = loadConfig({})
  assert.equal(c.port, 8080)
  assert.equal(c.mqttUrl, 'mqtt://localhost:1883')
  assert.equal(c.mqttTopic, 'leszyrun/checkpoint')
  assert.equal(c.goneWindowMs, 3000)
  assert.equal(c.uploadIntervalMs, 5000)
  assert.equal(c.dataDir, './data')
  assert.equal(c.supabaseUrl, null)
  assert.equal(c.readerPollMs, 15000)
})

test('env overrides', () => {
  const c = loadConfig({ AGENT_PORT: '9999', GONE_WINDOW_MS: '5000', SUPABASE_URL: 'https://x.supabase.co', READER_POLL_MS: '20000' })
  assert.equal(c.port, 9999)
  assert.equal(c.goneWindowMs, 5000)
  assert.equal(c.supabaseUrl, 'https://x.supabase.co')
  assert.equal(c.readerPollMs, 20000)
})
