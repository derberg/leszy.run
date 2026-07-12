import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { runCommand } from './exec.js';
import { sendFailureEmail } from './mailer.js';

const LOG_DIR = process.env.LOG_DIR || '/app/logs';
const COMPOSE_DIR = process.env.COMPOSE_DIR || '/workspace';

// Mirrors pipeline.js todayStampLocal() — YYYYMMDD in container TZ (Europe/Warsaw).
function todayStampLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

async function runBackendScript(name, scriptArgs) {
  await mkdir(LOG_DIR, { recursive: true });
  const logFileName = `${name}-${todayStampLocal()}.log`;
  const logPath = path.join(LOG_DIR, logFileName);
  const logStream = createWriteStream(logPath, { flags: 'a' });
  const logWrite = (line) => { logStream.write(line); };
  logWrite(`\n==== ${new Date().toISOString()} ${name} starting ====\n`);

  // Run inside the long-running backend container, in the backend workdir.
  // Mirrors pipeline.js dockerArgv() for type 'backend': backend's WORKDIR is /app,
  // scripts live at /app/backend/scripts/.
  const result = await runCommand({
    argv: ['docker', 'compose', 'exec', '-T', '--workdir', '/app/backend', 'backend', 'node', ...scriptArgs],
    cwd: COMPOSE_DIR,
    logWrite,
    timeoutMs: 10 * 60 * 1000,
  });

  logStream.end();

  if (result.exitCode !== 0) {
    try {
      await sendFailureEmail({
        stepIndex: 1,
        totalSteps: 1,
        stepName: name,
        exitCode: result.exitCode,
        stderrTail: result.stderrTail,
        logPath: path.join('logs', logFileName),
        durationMs: result.durationMs,
      });
      process.stdout.write(`[mail] failure email sent\n`);
    } catch (err) {
      process.stdout.write(`[mail] ${name} failure email FAILED to send: ${err.message}\n`);
    }
  }
  return result;
}

export function runDeadlineNotifications() {
  return runBackendScript('deadline-notifications', ['scripts/run-deadline-notifications.js', '--apply']);
}

export function runWeeklyDigest() {
  return runBackendScript('weekly-digest', ['scripts/run-weekly-digest.js', '--apply']);
}
