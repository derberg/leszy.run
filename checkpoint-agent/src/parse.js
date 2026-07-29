// Impinj R700 MQTT payload → normalized read. Same semantics as the backend's
// MQTT handler (backend/src/mqtt/client.js): only tagInventory events matter,
// EPC arrives base64-encoded and is used as uppercase hex everywhere else.
export function parseTagInventory(payloadBuf) {
  let data
  try { data = JSON.parse(payloadBuf.toString()) } catch { return null }
  if (data.eventType !== 'tagInventory' || !data.tagInventoryEvent) return null
  const { epc: epcRaw, peakRssiCdbm, antennaPort } = data.tagInventoryEvent
  if (!epcRaw) return null
  return {
    epc: Buffer.from(epcRaw, 'base64').toString('hex').toUpperCase(),
    rssiCdbm: peakRssiCdbm ?? null,
    antennaPort: antennaPort ?? null,
  }
}
