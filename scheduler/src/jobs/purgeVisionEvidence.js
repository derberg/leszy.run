import { runBackendScript } from '../notifications.js'

/**
 * Purge camera frames, bib crops and their rows once the retention period is
 * up (30 days by default — shorter than the 90 days gate_events gets, because
 * a photograph of a person is more sensitive than a tag read and its value
 * ends when the results are final).
 *
 * This is the automatic purge the ROPA entry promises. A retention period
 * nobody enforces is not a retention period.
 *
 * Delegates to the backend script, like purgeRfidLogs, so this container
 * needs no database connection. The one-shot backend container cannot see the
 * frame directories either, so the script refuses to delete a session whose
 * queue_dir it cannot reach and exits 1, which emails a failure.
 */
export async function purgeVisionEvidence() {
  const result = await runBackendScript(
    'purge-vision-evidence',
    ['scripts/purge-vision-evidence.js', '--apply'],
    // Deleting tens of thousands of JPEGs from a USB SSD is slower than a
    // couple of DELETE statements.
    { timeoutMs: 20 * 60 * 1000 },
  )

  if (result.exitCode !== 0) {
    throw new Error(`purge-vision-evidence exited with code ${result.exitCode}`)
  }

  return result
}
