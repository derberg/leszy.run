// Publishes canned Impinj tagInventory payloads to the local broker so the
// full agent pipeline can be exercised without an R700. Usage:
//   node scripts/simulate-reads.js --epc AABBCC01 [--topic leszyrun/checkpoint] [--url mqtt://localhost:1883]
// Emits a realistic approach curve (rising then falling RSSI, 200 ms apart),
// then goes silent — the agent should confirm ~3 s later at the peak.
import mqtt from 'mqtt'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  epc: { type: 'string' },
  topic: { type: 'string', default: 'leszyrun/checkpoint' },
  url: { type: 'string', default: 'mqtt://localhost:1883' },
} })
if (!values.epc) { console.error('--epc required (hex)'); process.exit(1) }

const epcB64 = Buffer.from(values.epc, 'hex').toString('base64')
const curve = [-6200, -5400, -4600, -3900, -4500, -5300, -6100]

const client = mqtt.connect(values.url)
client.on('connect', async () => {
  for (const rssi of curve) {
    client.publish(values.topic, JSON.stringify({
      eventType: 'tagInventory',
      tagInventoryEvent: { epc: epcB64, peakRssiCdbm: rssi, antennaPort: 1 },
    }))
    await new Promise(r => setTimeout(r, 200))
  }
  console.log(`published ${curve.length} reads for EPC ${values.epc.toUpperCase()} — expect confirm in ~3 s`)
  client.end()
})
