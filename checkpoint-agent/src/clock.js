import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { networkInterfaces } from 'node:os'

const exec = promisify(execFile)

// Pi without RTC boots in 1970 — a garbage observed_at corrupts position
// estimation, so recording is gated on this. On Linux, timedatectl knows.
// Where timedatectl is unavailable (macOS dev box) we return synced: null =
// "cannot determine" and the caller allows with a warning.
export async function clockStatus() {
  try {
    const { stdout } = await exec('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'])
    return { synced: stdout.trim() === 'yes', source: 'timedatectl' }
  } catch {
    return { synced: null, source: 'unavailable' }
  }
}

// All non-internal IPv4 addresses across every interface, paired with the
// interface name they're on — a checkpoint Pi commonly has two NICs
// (internet-facing wlan0/eth0 + a link-local USB-NIC straight to the R700),
// and the operator's phone/laptop might only be able to reach one of them.
// The single source of truth for the IPv4/non-internal filter — index.js
// uses this (via listLanIps()) for its startup printout instead of
// re-implementing the filter.
function listLanIfaces() {
  const entries = []
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) entries.push({ address: a.address, iface })
    }
  }
  return entries
}

// Plain array of address strings — printed in full at startup (see
// index.js) so the operator isn't stuck guessing which one to open.
export function listLanIps() {
  return listLanIfaces().map((e) => e.address)
}

// Same data, but keeping the interface name each address was found on —
// index.js's startup log wants both.
export function listLanIpsWithIface() {
  return listLanIfaces()
}

export function detectLanIp() {
  return listLanIps()[0] ?? null
}
