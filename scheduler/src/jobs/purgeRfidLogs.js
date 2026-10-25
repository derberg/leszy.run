import { runBackendScript } from '../notifications.js'

/**
 * Purge gate_events and gate_crossings rows tied to races that finished
 * more than 90 days ago. Delegates to the backend script so no DB
 * connection is needed in this container. A failure is logged to logs/ and
 * emailed, like every other backend job.
 */
export async function purgeRfidLogs() {
  const result = await runBackendScript('purge-rfid-logs', ['scripts/purge-rfid-logs.js'], {
    timeoutMs: 5 * 60 * 1000,
  })

  if (result.exitCode !== 0) {
    throw new Error(`purge-rfid-logs exited with code ${result.exitCode}`)
  }

  return result
}
