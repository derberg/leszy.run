import { runCommand } from '../exec.js'

const COMPOSE_DIR = process.env.COMPOSE_DIR || '/workspace'

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
 * needs no database connection AND no access to the frame volume.
 */
export async function purgeVisionEvidence() {
  const argv = [
    'docker', 'compose', 'exec', '-T',
    '--workdir', '/app/backend',
    'backend',
    'node', 'scripts/purge-vision-evidence.js', '--apply',
  ]

  const result = await runCommand({
    argv,
    cwd: COMPOSE_DIR,
    logWrite: (line) => process.stdout.write(line),
    // Deleting tens of thousands of JPEGs from a USB SSD is slower than a
    // couple of DELETE statements.
    timeoutMs: 20 * 60 * 1000,
  })

  if (result.exitCode !== 0) {
    throw new Error(`purge-vision-evidence exited with code ${result.exitCode}`)
  }

  return result
}
