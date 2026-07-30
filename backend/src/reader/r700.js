import { eq } from 'drizzle-orm'
import { settings } from '../db/schema.js'
import { Agent, fetch as undiciFetch } from 'undici'

// Agent that skips TLS verification — needed for R700 self-signed cert
const tlsAgent = new Agent({ connect: { rejectUnauthorized: false } })

export async function getSetting(db, key) {
  const [row] = await db.select().from(settings).where(eq(settings.key, key))
  return row?.value ?? null
}

export async function upsertSetting(db, key, value) {
  await db.insert(settings).values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
}

export async function getReaderAddr(db, role) {
  return getSetting(db, role === 'finish' ? 'reader_finish_ip' : 'reader_main_ip')
}

export async function getReaderCreds(db) {
  const [username, password] = await Promise.all([
    getSetting(db, 'reader_username'),
    getSetting(db, 'reader_password'),
  ])
  return { username: username ?? 'root', password: password ?? '' }
}

// Normalize whatever the user typed into a base URL without trailing slash.
// Accepts: "192.168.1.100", "impinj-17-0a-30.local", "https://impinj-17-0a-30.local/", etc.
export function normalizeReaderBase(addr) {
  const trimmed = addr.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '')
  }
  return `https://${trimmed.replace(/\/+$/, '')}`
}

export async function r700(addr, method, path, body, creds) {
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

// The MqttConfiguration payload pushed to a reader (see docs/impinj-r700-api/mqtt.md)
export function buildMqttConfig(role, mqttHost, topicPrefix, qos) {
  return {
    brokerHostname: mqttHost,
    brokerPort: 1883,
    clientId: role === 'finish' ? 'LeszyRunFinish' : 'LeszyRunMain',
    eventTopic: topicPrefix,
    active: true,
    tlsEnabled: false,
    cleanSession: false,
    eventQualityOfService: qos,
    keepAliveIntervalSeconds: 60,
  }
}

export async function getMqttSettings(db, role) {
  const [mqttHost, mqttTopicMain, mqttTopicFinish, mqttQosStr] = await Promise.all([
    getSetting(db, 'mqtt_host'),
    getSetting(db, 'mqtt_topic_main'),
    getSetting(db, 'mqtt_topic_finish'),
    getSetting(db, 'mqtt_qos'),
  ])
  return {
    mqttHost,
    topicPrefix: role === 'finish' ? (mqttTopicFinish ?? 'leszyrun/finish') : (mqttTopicMain ?? 'leszyrun'),
    qos: mqttQosStr != null ? parseInt(mqttQosStr, 10) : 1,
  }
}
