import mqtt from 'mqtt'
import { eq } from 'drizzle-orm'
import { settings } from '../db/schema.js'
import { CrossingDetector } from './crossingDetector.js'
import { broadcast } from '../ws/broadcaster.js'

let client = null
let detector = null
let scanModeActive = false
let currentTopics = []
let _db = null

const rfidState = {
  connected: false,
  lastMessageAt: null,
}

export function getMqttStatus() {
  return { connected: rfidState.connected, lastMessageAt: rfidState.lastMessageAt }
}

async function getTopicsFromDb() {
  if (!_db) return ['leszyrun/#', 'leszyrun']
  const rows = await _db.select().from(settings).where(
    eq(settings.key, 'mqtt_topic_main')
  )
  const main = rows[0]?.value ?? 'leszyrun'
  const rowsF = await _db.select().from(settings).where(
    eq(settings.key, 'mqtt_topic_finish')
  )
  const finish = rowsF[0]?.value ?? null
  const topics = [`${main}/#`, main]
  if (finish && finish !== main) topics.push(`${finish}/#`, finish)
  return [...new Set(topics)]
}

export async function resubscribeTopics() {
  if (!client || !rfidState.connected) return
  const next = await getTopicsFromDb()
  const toUnsub = currentTopics.filter(t => !next.includes(t))
  const toSub = next.filter(t => !currentTopics.includes(t))
  if (toUnsub.length) client.unsubscribe(toUnsub)
  if (toSub.length) client.subscribe(toSub, { qos: 2 })
  currentTopics = next
  console.log('[MQTT] Subscribed to topics:', next)
}

export function initMqtt(db) {
  _db = db
  const url = process.env.MQTT_URL || 'mqtt://localhost:1883'
  detector = new CrossingDetector({ db, broadcast })

  client = mqtt.connect(url, {
    clientId: 'leszyrun-backend',
    reconnectPeriod: 3000,
    connectTimeout: 10000,
  })

  client.on('connect', async () => {
    console.log(`[MQTT] Connected to ${url}`)
    rfidState.connected = true
    broadcast('rfid:status', { connected: true })
    currentTopics = await getTopicsFromDb()
    client.subscribe(currentTopics, { qos: 2 })
    console.log('[MQTT] Subscribed to topics:', currentTopics)
  })

  client.on('message', (topic, payload) => {
    let data
    try {
      data = JSON.parse(payload.toString())
    } catch {
      return // ignore non-JSON
    }

    if (data.eventType !== 'tagInventory' || !data.tagInventoryEvent) return

    rfidState.lastMessageAt = new Date().toISOString()

    const { epc: epcRaw, antennaPort, peakRssiCdbm, frequency } = data.tagInventoryEvent
    const epc = Buffer.from(epcRaw, 'base64').toString('hex').toUpperCase()
    const event = {
      epc,
      rssiCdbm: peakRssiCdbm,
      antennaPort,
      frequency,
      topic,
      receivedAt: new Date().toISOString(),
      raw: data,
    }

    // Always broadcast raw events for scan mode and live feed
    if (scanModeActive) {
      broadcast('rfid:scan', { epc, rssi: peakRssiCdbm, antennaPort, topic })
    }

    detector.processEvent(event)
  })

  client.on('error', (err) => console.error('[MQTT] Error:', err.message))
  client.on('offline', () => {
    console.warn('[MQTT] Offline')
    rfidState.connected = false
    broadcast('rfid:status', { connected: false })
  })
  client.on('reconnect', () => console.log('[MQTT] Reconnecting...'))
}

export function setScanMode(active) {
  scanModeActive = active
}

export function getDetector() {
  return detector
}
