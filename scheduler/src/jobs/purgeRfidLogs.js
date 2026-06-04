import { runCommand } from '../exec.js'

const COMPOSE_DIR = process.env.COMPOSE_DIR || '/workspace'

/**
 * Purge gate_events and gate_crossings rows tied to races that finished
 * more than 90 days ago. Delegates to the backend script so no DB
 * connection is needed in this container.
 */
export async function purgeRfidLogs() {
  const argv = [
    'docker', 'compose', 'exec', '-T',
    '--workdir', '/app/backend',
    'backend',
    'node', 'scripts/purge-rfid-logs.js',
  ]

  const result = await runCommand({
    argv,
    cwd: COMPOSE_DIR,
    logWrite: (line) => process.stdout.write(line),
    timeoutMs: 5 * 60 * 1000,
  })

  if (result.exitCode !== 0) {
    throw new Error(`purge-rfid-logs exited with code ${result.exitCode}`)
  }

  return result
}
