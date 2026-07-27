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

export function detectLanIp() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return null
}
