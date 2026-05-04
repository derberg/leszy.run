import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { sendMissedRunEmail } from './mailer.js';

const LOG_DIR = process.env.LOG_DIR || '/app/logs';
const HEARTBEAT_PATH = path.join(LOG_DIR, 'last-pipeline-ok.json');
const STALE_HOURS = Number(process.env.WATCHDOG_STALE_HOURS) || 26;

export async function runWatchdog() {
  let exists = false;
  try {
    await stat(HEARTBEAT_PATH);
    exists = true;
  } catch {
    /* missing */
  }

  if (!exists) {
    process.stdout.write(`[watchdog] heartbeat file ${HEARTBEAT_PATH} does not exist\n`);
    await sendMissedRunEmail({
      reason: `heartbeat file does not exist (${HEARTBEAT_PATH})`,
      lastSeenAt: null,
    });
    return { alerted: true, reason: 'missing' };
  }

  const raw = await readFile(HEARTBEAT_PATH, 'utf8');
  const beat = JSON.parse(raw);
  const ageHours = (Date.now() - new Date(beat.ts).getTime()) / 3_600_000;

  if (ageHours > STALE_HOURS) {
    process.stdout.write(`[watchdog] heartbeat ${ageHours.toFixed(1)}h old (threshold ${STALE_HOURS}h)\n`);
    await sendMissedRunEmail({
      reason: `heartbeat is ${ageHours.toFixed(1)}h old (threshold ${STALE_HOURS}h)`,
      lastSeenAt: beat.ts,
    });
    return { alerted: true, reason: 'stale', ageHours };
  }

  process.stdout.write(`[watchdog] heartbeat fresh (${ageHours.toFixed(1)}h old) — no alert\n`);
  return { alerted: false, ageHours };
}
