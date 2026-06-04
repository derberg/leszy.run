import cron from 'node-cron';
import { runPipeline } from './pipeline.js';
import { runWatchdog } from './watchdog.js';
import { purgeRfidLogs } from './jobs/purgeRfidLogs.js';

const TZ = process.env.TZ || 'Europe/Warsaw';
const PIPELINE_CRON = process.env.PIPELINE_CRON || '0 8 * * *';
const WATCHDOG_CRON = process.env.WATCHDOG_CRON || '0 10 * * *';
const PURGE_RFID_CRON = process.env.PURGE_RFID_CRON || '0 3 * * *';

let pipelineRunning = false;
let watchdogRunning = false;

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

console.log(
  `[scheduler] up. pipeline="${PIPELINE_CRON}" watchdog="${WATCHDOG_CRON}" purge="${PURGE_RFID_CRON}" tz=${TZ} ` +
  `now=${new Date().toLocaleString('sv-SE', { timeZone: TZ })}`
);

// Keep alive forever; node-cron uses setTimeout chains which already keep the loop busy.
