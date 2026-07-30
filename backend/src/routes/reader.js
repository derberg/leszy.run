import { createRequire } from 'module'
import { resubscribeTopics } from '../mqtt/client.js'
import { r700, getSetting, upsertSetting, getReaderAddr, getReaderCreds, buildMqttConfig, getMqttSettings } from '../reader/r700.js'
import { detectMqttHost } from '../reader/mqttHostHeal.js'

const require = createRequire(import.meta.url)
const PRESET = require('../inventory-preset.json')

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

  // GET /api/reader/:role/detect-mqtt-host — which Mac IP the reader can actually
  // reach (the interface that shares a subnet with the reader), vs. what's stored
  fastify.get('/reader/:role/detect-mqtt-host', async (req, reply) => {
    const [ip, stored] = await Promise.all([getReaderAddr(db, req.params.role), getSetting(db, 'mqtt_host')])
    if (!ip) return reply.code(404).send({ error: 'Reader IP not configured' })
    try {
      const detected = await detectMqttHost(ip)
      return { data: { detected: detected?.ip ?? null, iface: detected?.iface ?? null, readerIp: detected?.readerIp ?? null, stored: stored ?? null } }
    } catch (err) {
      return reply.code(502).send({ error: err.message })
    }
  })

  // POST /api/reader/:role/configure — push MQTT settings + inventory preset.
  // If the saved Host MQTT no longer matches any local interface that can reach
  // the reader (the Mac's link-local IP changed), auto-correct it first.
  fastify.post('/reader/:role/configure', async (req, reply) => {
    const [ip, creds, mqttSettings, storedPreset] = await Promise.all([
      getReaderAddr(db, req.params.role), getReaderCreds(db),
      getMqttSettings(db, req.params.role),
      getSetting(db, 'inventory_preset'),
    ])
    const activePreset = storedPreset ? JSON.parse(storedPreset) : PRESET
    if (!ip) return reply.code(404).send({ error: 'Reader IP not configured' })
    let { mqttHost, topicPrefix, qos } = mqttSettings
    if (!mqttHost) return reply.code(400).send({ error: 'MQTT host not configured' })
    let mqttHostAutocorrected = null
    try {
      const detected = await detectMqttHost(ip)
      if (detected && detected.ip !== mqttHost) {
        mqttHostAutocorrected = { from: mqttHost, to: detected.ip, iface: detected.iface }
        mqttHost = detected.ip
        await upsertSetting(db, 'mqtt_host', detected.ip)
        console.log(`[reader-heal] ${req.params.role}: configure auto-corrected Host MQTT ${mqttHostAutocorrected.from} → ${detected.ip}`)
      }
    } catch { /* detection failing must not block a manual configure */ }
    try {
      await r700(ip, 'PUT', '/mqtt', buildMqttConfig(req.params.role, mqttHost, topicPrefix, qos), creds)
    } catch (err) {
      return reply.code(502).send({ error: `[MQTT config] ${err.message}` })
    }
    try {
      await r700(ip, 'PUT', '/profiles/inventory/presets/leszyrun', activePreset, creds)
      return { data: { ok: true, mqttHostAutocorrected } }
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
