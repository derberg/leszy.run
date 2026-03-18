import { eq } from 'drizzle-orm'
import { settings } from '../db/schema.js'
import { Agent, fetch as undiciFetch } from 'undici'
import { createRequire } from 'module'
import { resubscribeTopics } from '../mqtt/client.js'

const require = createRequire(import.meta.url)
const PRESET = require('../inventory-preset.json')

// Agent that skips TLS verification — needed for R700 self-signed cert
const tlsAgent = new Agent({ connect: { rejectUnauthorized: false } })

async function getSetting(db, key) {
  const [row] = await db.select().from(settings).where(eq(settings.key, key))
  return row?.value ?? null
}

async function upsertSetting(db, key, value) {
  await db.insert(settings).values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
}

async function getReaderAddr(db, role) {
  return getSetting(db, role === 'finish' ? 'reader_finish_ip' : 'reader_main_ip')
}

async function getReaderCreds(db) {
  const [username, password] = await Promise.all([
    getSetting(db, 'reader_username'),
    getSetting(db, 'reader_password'),
  ])
  return { username: username ?? 'root', password: password ?? '' }
}

// Normalize whatever the user typed into a base URL without trailing slash.
// Accepts: "192.168.1.100", "impinj-17-0a-30.local", "https://impinj-17-0a-30.local/", etc.
function normalizeReaderBase(addr) {
  const trimmed = addr.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '')
  }
  return `https://${trimmed.replace(/\/+$/, '')}`
}

async function r700(addr, method, path, body, creds) {
  const base = normalizeReaderBase(addr)
  const url = `${base}/api/v1${path}`
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (creds?.username) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${creds.username}:${creds.password ?? ''}`).toString('base64')
  }
  const opts = {
    method,
    headers,
    signal: AbortSignal.timeout(5000),
    dispatcher: tlsAgent,
  }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await undiciFetch(url, opts)
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!res.ok) throw new Error(`R700 HTTP ${res.status}: ${JSON.stringify(data)}`)
  return data
}

export async function readerRoutes(fastify) {
  const { db } = fastify

  // GET /api/reader/config
  fastify.get('/reader/config', async () => {
    const [mainIp, finishIp, mqttHost, readerUsername, readerPassword, mqttQos, mqttTopicMain, mqttTopicFinish] = await Promise.all([
      getSetting(db, 'reader_main_ip'),
      getSetting(db, 'reader_finish_ip'),
      getSetting(db, 'mqtt_host'),
      getSetting(db, 'reader_username'),
      getSetting(db, 'reader_password'),
      getSetting(db, 'mqtt_qos'),
      getSetting(db, 'mqtt_topic_main'),
      getSetting(db, 'mqtt_topic_finish'),
    ])
    return { data: { mainIp: mainIp ?? '', finishIp: finishIp ?? '', mqttHost: mqttHost ?? '', readerUsername: readerUsername ?? 'root', readerPassword: readerPassword ?? '', mqttQos: mqttQos != null ? parseInt(mqttQos, 10) : 1, mqttTopicMain: mqttTopicMain ?? 'leszyrun', mqttTopicFinish: mqttTopicFinish ?? 'leszyrun/finish' } }
  })

  // GET /api/reader/preset — return the inventory preset used when configuring readers
  // Seeds DB from JSON file on first call
  fastify.get('/reader/preset', async () => {
    const stored = await getSetting(db, 'inventory_preset')
    if (stored) return { data: JSON.parse(stored) }
    await upsertSetting(db, 'inventory_preset', JSON.stringify(PRESET))
    return { data: PRESET }
  })

  // PUT /api/reader/preset — save edited preset to DB
  fastify.put('/reader/preset', async (req, reply) => {
    const { antennaConfigs } = req.body
    if (!Array.isArray(antennaConfigs) || !antennaConfigs.length) {
      return reply.code(400).send({ error: 'antennaConfigs required' })
    }
    const preset = { antennaConfigs }
    await upsertSetting(db, 'inventory_preset', JSON.stringify(preset))
    return { data: preset }
  })

  // PATCH /api/reader/config
  fastify.patch('/reader/config', async (req, reply) => {
    const fieldToKey = { mainIp: 'reader_main_ip', finishIp: 'reader_finish_ip', mqttHost: 'mqtt_host', readerUsername: 'reader_username', readerPassword: 'reader_password', mqttQos: 'mqtt_qos', mqttTopicMain: 'mqtt_topic_main', mqttTopicFinish: 'mqtt_topic_finish' }
    const ops = []
    for (const [field, key] of Object.entries(fieldToKey)) {
      if (req.body[field] !== undefined) ops.push(upsertSetting(db, key, req.body[field]))
    }
    if (!ops.length) return reply.code(400).send({ error: 'No fields to update' })
    await Promise.all(ops)
    if (req.body.mqttTopicMain !== undefined || req.body.mqttTopicFinish !== undefined) {
      await resubscribeTopics()
    }
    return { data: { ok: true } }
  })

  // GET /api/reader/:role/status — combines /status + system endpoints for full diagnostics
  fastify.get('/reader/:role/status', async (req, reply) => {
    const [ip, creds] = await Promise.all([getReaderAddr(db, req.params.role), getReaderCreds(db)])
    if (!ip) return reply.code(404).send({ error: 'Reader IP not configured' })
    try {
      const [status, image, temp, time, power] = await Promise.all([
        r700(ip, 'GET', '/status', undefined, creds),
        r700(ip, 'GET', '/system/image', undefined, creds).catch(() => null),
        r700(ip, 'GET', '/system/temperature', undefined, creds).catch(() => null),
        r700(ip, 'GET', '/system/time', undefined, creds).catch(() => null),
        r700(ip, 'GET', '/system/power', undefined, creds).catch(() => null),
      ])
      return {
        data: {
          ...status,
          firmwareVersion: image?.primaryFirmware ?? null,
          temperatureCelsius: temp?.systemTemperature ?? null,
          uptimeSeconds: time?.upTime ?? null,
          powerSource: power?.powerSource ?? null,
          allocatedPowerMilliwatts: power?.allocatedPowerMilliwatts ?? null,
        },
      }
    } catch (err) {
      return reply.code(502).send({ error: err.message })
    }
  })

  // GET /api/reader/:role/antennas — proxy R700 /system/antenna-hub
  fastify.get('/reader/:role/antennas', async (req, reply) => {
    const [ip, creds] = await Promise.all([getReaderAddr(db, req.params.role), getReaderCreds(db)])
    if (!ip) return reply.code(404).send({ error: 'Reader IP not configured' })
    try {
      const data = await r700(ip, 'GET', '/system/antenna-hub', undefined, creds)
      return { data }
    } catch (err) {
      return reply.code(502).send({ error: err.message })
    }
  })

  // POST /api/reader/:role/configure — push MQTT settings + inventory preset
  fastify.post('/reader/:role/configure', async (req, reply) => {
    const [ip, creds, mqttHost, mqttTopicMain, mqttTopicFinish, mqttQosStr, storedPreset] = await Promise.all([
      getReaderAddr(db, req.params.role), getReaderCreds(db),
      getSetting(db, 'mqtt_host'), getSetting(db, 'mqtt_topic_main'),
      getSetting(db, 'mqtt_topic_finish'), getSetting(db, 'mqtt_qos'),
      getSetting(db, 'inventory_preset'),
    ])
    const activePreset = storedPreset ? JSON.parse(storedPreset) : PRESET
    if (!ip) return reply.code(404).send({ error: 'Reader IP not configured' })
    if (!mqttHost) return reply.code(400).send({ error: 'MQTT host not configured' })
    const topicPrefix = req.params.role === 'finish' ? (mqttTopicFinish ?? 'leszyrun/finish') : (mqttTopicMain ?? 'leszyrun')
    const qos = mqttQosStr != null ? parseInt(mqttQosStr, 10) : 1
    try {
      await r700(ip, 'PUT', '/mqtt', {
        brokerHostname: mqttHost,
        brokerPort: 1883,
        clientId: req.params.role === 'finish' ? 'LeszyRunFinish' : 'LeszyRunMain',
        eventTopic: topicPrefix,
        active: true,
        tlsEnabled: false,
        cleanSession: false,
        eventQualityOfService: qos,
        keepAliveIntervalSeconds: 60,
      }, creds)
    } catch (err) {
      return reply.code(502).send({ error: `[MQTT config] ${err.message}` })
    }
    try {
      await r700(ip, 'PUT', '/profiles/inventory/presets/leszyrun', activePreset, creds)
      return { data: { ok: true } }
    } catch (err) {
      return reply.code(502).send({ error: `[Preset upload] ${err.message}` })
    }
  })

  // POST /api/reader/:role/start — upload preset then start inventory
  fastify.post('/reader/:role/start', async (req, reply) => {
    const [ip, creds, storedPreset] = await Promise.all([
      getReaderAddr(db, req.params.role), getReaderCreds(db),
      getSetting(db, 'inventory_preset'),
    ])
    if (!ip) return reply.code(404).send({ error: 'Reader IP not configured' })
    const activePreset = storedPreset ? JSON.parse(storedPreset) : PRESET
    try {
      await r700(ip, 'PUT', '/profiles/inventory/presets/leszyrun', activePreset, creds)
    } catch (err) {
      return reply.code(502).send({ error: `[Preset upload] ${err.message}` })
    }
    try {
      await r700(ip, 'POST', '/profiles/inventory/presets/leszyrun/start', {}, creds)
      return { data: { ok: true } }
    } catch (err) {
      return reply.code(502).send({ error: `[Start inventory] ${err.message}` })
    }
  })

  // POST /api/reader/:role/stop — stop inventory
  fastify.post('/reader/:role/stop', async (req, reply) => {
    const [ip, creds] = await Promise.all([getReaderAddr(db, req.params.role), getReaderCreds(db)])
    if (!ip) return reply.code(404).send({ error: 'Reader IP not configured' })
    try {
      await r700(ip, 'POST', '/profiles/stop', {}, creds)
      return { data: { ok: true } }
    } catch (err) {
      return reply.code(502).send({ error: err.message })
    }
  })
}
