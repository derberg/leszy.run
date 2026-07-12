import cron from 'node-cron';
import { runPipeline } from './pipeline.js';
import { runWatchdog } from './watchdog.js';
import { purgeRfidLogs } from './jobs/purgeRfidLogs.js';
import { runDeadlineNotifications, runWeeklyDigest } from './notifications.js';

const TZ = process.env.TZ || 'Europe/Warsaw';
const PIPELINE_CRON = process.env.PIPELINE_CRON || '0 8 * * *';
const WATCHDOG_CRON = process.env.WATCHDOG_CRON || '0 10 * * *';
const PURGE_RFID_CRON = process.env.PURGE_RFID_CRON || '0 3 * * *';
const DEADLINE_CRON = process.env.DEADLINE_CRON || '30 8 * * *';   // daily 08:30
const DIGEST_CRON = process.env.DIGEST_CRON || '0 9 * * 1';       // Monday 09:00

let pipelineRunning = false;
let watchdogRunning = false;
let deadlineRunning = false;
let digestRunning = false;

cron.schedule(
  PIPELINE_CRON,
  async () => {
    if (pipelineRunning) {
      console.log(`[cron] pipeline already running, skipping ${new Date().toISOString()}`);
      return;
    }
    pipelineRunning = true;
    console.log(`[cron] pipeline trigger at ${new Date().toISOString()}`);
    try {
      const result = await runPipeline();
      console.log(`[cron] pipeline finished:`, JSON.stringify(result));
    } catch (err) {
      console.error(`[cron] pipeline threw:`, err);
    } finally {
      pipelineRunning = false;
    }
  },
  { timezone: TZ }
);

cron.schedule(
  WATCHDOG_CRON,
  async () => {
    if (watchdogRunning) return;
    watchdogRunning = true;
    console.log(`[cron] watchdog trigger at ${new Date().toISOString()}`);
    try {
      const result = await runWatchdog();
      console.log(`[cron] watchdog finished:`, JSON.stringify(result));
    } catch (err) {
      console.error(`[cron] watchdog threw:`, err);
    } finally {
      watchdogRunning = false;
    }
  },
  { timezone: TZ }
);

cron.schedule(
  PURGE_RFID_CRON,
  async () => {
    console.log(`[cron] purge-rfid-logs trigger at ${new Date().toISOString()}`);
    try {
      await purgeRfidLogs();
      console.log(`[cron] purge-rfid-logs finished`);
    } catch (err) {
      console.error(`[cron] purge-rfid-logs threw:`, err);
    }
  },
  { timezone: TZ }
);

cron.schedule(
  DEADLINE_CRON,
  async () => {
    if (deadlineRunning) {
      console.log(`[cron] deadline-notifications already running, skipping ${new Date().toISOString()}`);
      return;
    }
    deadlineRunning = true;
    console.log(`[cron] deadline-notifications trigger at ${new Date().toISOString()}`);
    try {
      const result = await runDeadlineNotifications();
      console.log(`[cron] deadline-notifications finished:`, JSON.stringify({ exitCode: result.exitCode, durationMs: result.durationMs }));
    } catch (err) {
      console.error(`[cron] deadline-notifications threw:`, err);
    } finally {
      deadlineRunning = false;
    }
  },
  { timezone: TZ }
);

cron.schedule(
  DIGEST_CRON,
  async () => {
    if (digestRunning) {
      console.log(`[cron] weekly-digest already running, skipping ${new Date().toISOString()}`);
      return;
    }
    digestRunning = true;
    console.log(`[cron] weekly-digest trigger at ${new Date().toISOString()}`);
    try {
      const result = await runWeeklyDigest();
      console.log(`[cron] weekly-digest finished:`, JSON.stringify({ exitCode: result.exitCode, durationMs: result.durationMs }));
    } catch (err) {
      console.error(`[cron] weekly-digest threw:`, err);
    } finally {
      digestRunning = false;
    }
  },
  { timezone: TZ }
);

console.log(
  `[scheduler] up. pipeline="${PIPELINE_CRON}" watchdog="${WATCHDOG_CRON}" purge="${PURGE_RFID_CRON}" ` +
  `deadline="${DEADLINE_CRON}" digest="${DIGEST_CRON}" tz=${TZ} ` +
  `now=${new Date().toLocaleString('sv-SE', { timeZone: TZ })}`
);

// Keep alive forever; node-cron uses setTimeout chains which already keep the loop busy.
