import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { runCommand } from './exec.js';
import { sendFailureEmail, sendNoOutputEmail } from './mailer.js';

const LOG_DIR = process.env.LOG_DIR || '/app/logs';
const HEARTBEAT_PATH = path.join(LOG_DIR, 'last-pipeline-ok.json');
const COMPOSE_DIR = process.env.COMPOSE_DIR || '/workspace';

const STEPS = [
  { name: 'run-scrapers',      type: 'backend',  cmd: ['node', 'scripts/run-scrapers.js'] },
  { name: 'run-merge',         type: 'backend',  cmd: ['node', 'scripts/run-merge.js', '--apply'] },
  { name: 'run-dedup-1',       type: 'backend',  cmd: ['node', 'scripts/run-dedup.js', '--apply'] },
  { name: 'run-geocode',       type: 'backend',  cmd: ['node', 'scripts/run-geocode.js', '--apply'] },
  { name: 'run-enrich-flags',  type: 'backend',  cmd: ['node', 'scripts/run-enrich-flags.js', '--apply'] },
  { name: 'run-normalize-1',   type: 'backend',  cmd: ['node', 'scripts/run-normalize.js', '--apply'] },
  { name: 'enricher',          type: 'enricher', cmd: ['python', '-m', 'enricher', 'run'], timeoutMs: 4 * 60 * 60 * 1000 },
  { name: 'run-enrich-search', type: 'backend',  cmd: ['node', 'scripts/run-enrich-search.js', '--apply'] },
  { name: 'run-dedup-2',       type: 'backend',  cmd: ['node', 'scripts/run-dedup.js', '--apply'] },
  { name: 'run-normalize-2',   type: 'backend',  cmd: ['node', 'scripts/run-normalize.js', '--apply'] },
  { name: 'run-publish',             type: 'backend',  cmd: ['node', 'scripts/run-publish.js', '--apply'] },
  { name: 'publish-landing-pages',  type: 'backend',  cmd: ['node', 'scripts/publish-landing-pages.js', '--apply'] },
];

function dockerArgv(step) {
  if (step.type === 'backend') {
    // Run inside the long-running backend container, in the backend workdir.
    // backend's WORKDIR in its Dockerfile is /app, scripts live at /app/backend/scripts/.
    return ['docker', 'compose', 'exec', '-T', '--workdir', '/app/backend', 'backend', ...step.cmd];
  }
  if (step.type === 'enricher') {
    // One-shot enricher container. `--profile run-once` matches the compose definition.
    // `--no-deps` is critical: without it, compose would try to (re)start `searxng` as
    // a dependency, but its bind mount uses a path relative to the compose file. The
    // scheduler sees the compose file at /workspace/docker-compose.yml inside its
    // container, so the daemon ends up asking macOS to mount /workspace/enricher/...
    // which doesn't exist on the host. searxng must already be running on the host.
    return ['docker', 'compose', '--profile', 'run-once', 'run', '--rm', '--no-deps', '-T', 'enricher', ...step.cmd];
  }
  throw new Error(`unknown step type: ${step.type}`);
}

function todayStampLocal() {
  // YYYYMMDD in container TZ (Europe/Warsaw)
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function todayStartIsoLocal() {
  // Start-of-today in container TZ, returned as ISO UTC string for Supabase comparison.
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function verifyRowsChanged() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { rowsCreated: null, rowsUpdated: null, skipped: true };
  }
  const since = todayStartIsoLocal();
  const headers = { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' };

  async function countWhere(filter) {
    const u = `${url}/rest/v1/calendar_events?select=id&${filter}&limit=1`;
    const res = await fetch(u, { headers });
    if (!res.ok) throw new Error(`Supabase count failed: ${res.status} ${await res.text()}`);
    const range = res.headers.get('content-range') || '';
    const total = Number(range.split('/').pop()) || 0;
    return total;
  }

  const [rowsCreated, rowsUpdated] = await Promise.all([
    countWhere(`created_at=gte.${encodeURIComponent(since)}`),
    countWhere(`updated_at=gte.${encodeURIComponent(since)}`),
  ]);
  return { rowsCreated, rowsUpdated, skipped: false };
}

export async function runPipeline() {
  await mkdir(LOG_DIR, { recursive: true });
  const logFileName = `daily-pipeline-${todayStampLocal()}.log`;
  const logPath = path.join(LOG_DIR, logFileName);
  // Path the operator will see in failure emails — relative to repo root on host.
  const hostLogPath = path.join('logs', logFileName);

  const logStream = createWriteStream(logPath, { flags: 'a' });
  const logWrite = (line) => { logStream.write(line); };
  const logHeader = (line) => {
    process.stdout.write(line);
    logStream.write(line);
  };

  logHeader(`\n==== ${new Date().toISOString()} daily pipeline starting ====\n`);

  const startedAt = Date.now();
  const stepResults = [];

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    const stepIndex = i + 1;
    logHeader(`[${stepIndex}/${STEPS.length}] ${step.name}\n`);

    const argv = dockerArgv(step);
    const result = await runCommand({
      argv,
      cwd: COMPOSE_DIR,
      logWrite,
      timeoutMs: step.timeoutMs ?? 30 * 60 * 1000,
    });

    stepResults.push({
      name: step.name,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });

    if (result.exitCode !== 0) {
      logHeader(`[FAIL] step ${stepIndex}/${STEPS.length} ${step.name} exited ${result.exitCode}\n`);
      logStream.end();
      try {
        await sendFailureEmail({
          stepIndex,
          totalSteps: STEPS.length,
          stepName: step.name,
          exitCode: result.exitCode,
          stderrTail: result.stderrTail,
          logPath: hostLogPath,
          durationMs: result.durationMs,
        });
        process.stdout.write(`[mail] failure email sent\n`);
      } catch (err) {
        process.stdout.write(`[mail] failure email FAILED to send: ${err.message}\n`);
      }
      return { ok: false, failedStep: step.name, stepResults };
    }
  }

  const totalDurationMs = Date.now() - startedAt;

  // Output verification: did we actually change anything in calendar_events today?
  let verification = { rowsCreated: null, rowsUpdated: null, skipped: true };
  try {
    verification = await verifyRowsChanged();
  } catch (err) {
    logHeader(`[verify] supabase count query failed: ${err.message}\n`);
  }

  logHeader(
    `==== ${new Date().toISOString()} daily pipeline complete ` +
    `(${(totalDurationMs / 1000 / 60).toFixed(1)} min, ` +
    `+${verification.rowsCreated ?? '?'} created, ` +
    `~${verification.rowsUpdated ?? '?'} updated) ====\n`
  );

  const heartbeat = {
    ts: new Date().toISOString(),
    durationMs: totalDurationMs,
    steps: stepResults,
    rowsCreated: verification.rowsCreated,
    rowsUpdated: verification.rowsUpdated,
    rowsCheckSkipped: verification.skipped,
  };
  await writeFile(HEARTBEAT_PATH, JSON.stringify(heartbeat, null, 2));

  logStream.end();

  // Warn if nothing changed (only if we successfully queried).
  if (!verification.skipped && (verification.rowsCreated + verification.rowsUpdated === 0)) {
    try {
      await sendNoOutputEmail({
        rowsCreated: verification.rowsCreated,
        rowsUpdated: verification.rowsUpdated,
        durationMs: totalDurationMs,
        logPath: hostLogPath,
      });
      process.stdout.write(`[mail] zero-rows warning email sent\n`);
    } catch (err) {
      process.stdout.write(`[mail] zero-rows warning email FAILED: ${err.message}\n`);
    }
  }

  return { ok: true, stepResults, ...verification };
}
