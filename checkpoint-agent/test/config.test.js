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
  // 3s on purpose: this interval is also how long a post-gun checkpoint pass can
  // be silently dropped while the agent is still disarmed. See config.js.
  assert.equal(c.armPollMs, 3000)
  assert.equal(c.heartbeatMs, 15000)
})

test('env overrides', () => {
  const c = loadConfig({ AGENT_PORT: '9999', GONE_WINDOW_MS: '5000', SUPABASE_URL: 'https://x.supabase.co', READER_POLL_MS: '20000', ARM_POLL_MS: '10000', HEARTBEAT_MS: '30000' })
  assert.equal(c.port, 9999)
  assert.equal(c.goneWindowMs, 5000)
  assert.equal(c.supabaseUrl, 'https://x.supabase.co')
  assert.equal(c.readerPollMs, 20000)
  assert.equal(c.armPollMs, 10000)
  assert.equal(c.heartbeatMs, 30000)
})

test('autoconfig absent when no AUTOCONFIG_* env vars are set', () => {
  const c = loadConfig({})
  assert.equal(c.autoconfig.present, false)
})

test('autoconfig absent when required fields are incomplete (missing pin)', () => {
  const c = loadConfig({ AUTOCONFIG_EVENT_ID: 'ev1', AUTOCONFIG_CHECKPOINT_ID: 'cp1', AUTOCONFIG_READER_IP: '10.0.0.5' })
  assert.equal(c.autoconfig.present, false)
})

test('autoconfig absent when eventId/checkpointId/pin are set but readerIp is missing and noReader is not set', () => {
  const c = loadConfig({ AUTOCONFIG_EVENT_ID: 'ev1', AUTOCONFIG_CHECKPOINT_ID: 'cp1', AUTOCONFIG_PIN: '123456' })
  assert.equal(c.autoconfig.present, false)
})

test('autoconfig present when eventId + checkpointId + pin + readerIp are all set', () => {
  const c = loadConfig({
    AUTOCONFIG_EVENT_ID: 'ev1',
    AUTOCONFIG_CHECKPOINT_ID: 'cp1',
    AUTOCONFIG_PIN: '123456',
    AUTOCONFIG_READER_IP: '10.0.0.5',
  })
  assert.equal(c.autoconfig.present, true)
  assert.equal(c.autoconfig.eventId, 'ev1')
  assert.equal(c.autoconfig.checkpointId, 'cp1')
  assert.equal(c.autoconfig.pin, '123456')
  assert.equal(c.autoconfig.readerIp, '10.0.0.5')
})

test('autoconfig present when noReader is set even without readerIp', () => {
  const c = loadConfig({
    AUTOCONFIG_EVENT_ID: 'ev1',
    AUTOCONFIG_CHECKPOINT_ID: 'cp1',
    AUTOCONFIG_PIN: '123456',
    AUTOCONFIG_NO_READER: 'true',
  })
  assert.equal(c.autoconfig.present, true)
  assert.equal(c.autoconfig.noReader, true)
  assert.equal(c.autoconfig.readerIp, null)
})

test('autoconfig noReader parses "1" as true, and defaults to false when unset', () => {
  assert.equal(loadConfig({ AUTOCONFIG_NO_READER: '1' }).autoconfig.noReader, true)
  assert.equal(loadConfig({}).autoconfig.noReader, false)
  assert.equal(loadConfig({ AUTOCONFIG_NO_READER: 'false' }).autoconfig.noReader, false)
})

test('autoconfig armMode defaults to race_start when unset', () => {
  const c = loadConfig({ AUTOCONFIG_EVENT_ID: 'ev1', AUTOCONFIG_CHECKPOINT_ID: 'cp1', AUTOCONFIG_PIN: '123456', AUTOCONFIG_READER_IP: '10.0.0.5' })
  assert.equal(c.autoconfig.armMode, 'race_start')
})

test('autoconfig armMode accepts immediate, falls back to race_start on garbage', () => {
  assert.equal(loadConfig({ AUTOCONFIG_ARM_MODE: 'immediate' }).autoconfig.armMode, 'immediate')
  assert.equal(loadConfig({ AUTOCONFIG_ARM_MODE: 'race_start' }).autoconfig.armMode, 'race_start')
  assert.equal(loadConfig({ AUTOCONFIG_ARM_MODE: 'bogus' }).autoconfig.armMode, 'race_start')
})

test('autoconfig picks up optional reader creds, mqtt host override, and display names', () => {
  const c = loadConfig({
    AUTOCONFIG_EVENT_ID: 'ev1',
    AUTOCONFIG_CHECKPOINT_ID: 'cp1',
    AUTOCONFIG_PIN: '123456',
    AUTOCONFIG_READER_IP: '10.0.0.5',
    AUTOCONFIG_MQTT_HOST: '192.168.1.50',
    AUTOCONFIG_READER_USER: 'admin',
    AUTOCONFIG_READER_PASSWORD: 'secret',
    AUTOCONFIG_EVENT_NAME: 'Bieg Testowy',
    AUTOCONFIG_CHECKPOINT_NAME: 'CP 3',
  })
  assert.equal(c.autoconfig.mqttHost, '192.168.1.50')
  assert.equal(c.autoconfig.readerUsername, 'admin')
  assert.equal(c.autoconfig.readerPassword, 'secret')
  assert.equal(c.autoconfig.eventName, 'Bieg Testowy')
  assert.equal(c.autoconfig.checkpointName, 'CP 3')
})
