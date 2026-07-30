// MQTT host auto-detect + auto-heal.
//
// On a direct cable the Mac self-assigns a random link-local 169.254.x.x that
// CHANGES after reboots/replugs, while the R700 keeps whatever brokerHostname
// was last pushed to it — so the reader silently loses MQTT until a human
// notices, re-reads `ifconfig`, updates Host MQTT, and re-pushes the config.
// This module removes the human: the backend (native macOS process — it can see
// the real interfaces, which was impossible from inside Docker) works out which
// interface routes to the reader, takes the Mac's IPv4 on it, and re-pushes the
// reader's MQTT config whenever it drifts.
//
// Deliberately NOT touched here: the inventory preset and tag streaming —
// pushing/starting radios stays a human action in the UI.
import os from 'os'
import dns from 'dns/promises'
import { broadcast } from '../ws/broadcaster.js'
import { r700, getSetting, upsertSetting, getReaderAddr, getReaderCreds, buildMqttConfig, getMqttSettings } from './r700.js'

const ipToInt = (ip) => ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0
const sameSubnet = (a, b, mask) => (ipToInt(a) & ipToInt(mask)) === (ipToInt(b) & ipToInt(mask))

async function resolveReaderIp(addr) {
  const host = addr.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host
  // Native macOS getaddrinfo resolves .local hostnames via mDNS
  const { address } = await dns.lookup(host, { family: 4 })
  return address
}

/**
 * Figure out which local interface can reach the reader and return the Mac's
 * IPv4 on it — the only broker address the reader can connect back to.
 * Returns { ip, iface, readerIp } or null when no interface shares a subnet.
 */
export async function detectMqttHost(readerAddr) {
  const readerIp = await resolveReaderIp(readerAddr)
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (sameSubnet(a.address, readerIp, a.netmask)) {
        return { ip: a.address, iface, readerIp }
      }
    }
  }
  return null
}

async function healRole(db, role) {
  const addr = await getReaderAddr(db, role)
  if (!addr) return
  const { mqttHost: stored, topicPrefix, qos } = await getMqttSettings(db, role)
  if (!stored) return // MQTT never configured — don't start configuring readers on our own

  let detected
  try { detected = await detectMqttHost(addr) } catch { return } // reader hostname not resolvable → reader likely off
  if (!detected) return

  const creds = await getReaderCreds(db)
  let current
  try { current = await r700(addr, 'GET', '/mqtt', undefined, creds) } catch { return } // reader unreachable → nothing to heal

  const upToDate = current.brokerHostname === detected.ip && current.active === true
  if (upToDate) {
    // Reader is fine; quietly keep the saved Host MQTT field in step with reality.
    if (stored !== detected.ip) await upsertSetting(db, 'mqtt_host', detected.ip)
    return
  }

  if (stored !== detected.ip) await upsertSetting(db, 'mqtt_host', detected.ip)
  await r700(addr, 'PUT', '/mqtt', buildMqttConfig(role, detected.ip, topicPrefix, qos), creds)
  console.log(`[reader-heal] ${role}: broker ${current.brokerHostname ?? '(none)'} → ${detected.ip} (Mac ${detected.iface}, reader ${detected.readerIp})`)
  broadcast('reader:autoheal', { role, from: current.brokerHostname ?? null, to: detected.ip, iface: detected.iface })
}

export function initMqttHostHeal(db, { intervalMs = 30_000 } = {}) {
  let running = false
  setInterval(async () => {
    if (running) return
    running = true
    try {
      const finishIp = await getSetting(db, 'reader_finish_ip')
      const roles = finishIp?.trim() ? ['main', 'finish'] : ['main']
      for (const role of roles) {
        try { await healRole(db, role) } catch (err) { console.error(`[reader-heal] ${role}:`, err.message) }
      }
    } finally {
      running = false
    }
  }, intervalMs)
  console.log('[reader-heal] MQTT host watchdog started')
}
