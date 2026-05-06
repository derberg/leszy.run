import sgMail from '@sendgrid/mail';
import { convert } from 'html-to-text';

const FROM = process.env.SENDGRID_FROM_EMAIL || 'biuro@zatyrani.pl';
const TO = process.env.PIPELINE_ALERT_EMAIL;

const htmlToTextOptions = {
  wordwrap: 80,
  selectors: [
    { selector: 'a', options: { ignoreHref: false } },
    { selector: 'pre', format: 'block' },
  ],
};

function ensureConfig() {
  if (!process.env.SENDGRID_API_KEY) throw new Error('SENDGRID_API_KEY not set');
  if (!TO) throw new Error('PIPELINE_ALERT_EMAIL not set');
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

async function send({ subject, html }) {
  ensureConfig();
  const msg = {
    to: TO,
    from: FROM,
    subject,
    text: convert(html, htmlToTextOptions),
    html,
  };
  return sgMail.send(msg);
}

const escapeHtml = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export async function sendFailureEmail({ stepIndex, totalSteps, stepName, exitCode, stderrTail, logPath, durationMs }) {
  const subject = `[FAIL] LeszyRun pipeline step ${stepIndex}/${totalSteps} (${stepName})`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 720px; margin: 0 auto;">
      <h2 style="color: #dc2626;">⚠️ Pipeline failed</h2>
      <p><strong>Step ${stepIndex}/${totalSteps}:</strong> <code>${escapeHtml(stepName)}</code></p>
      <p><strong>Exit code:</strong> ${exitCode}</p>
      <p><strong>Step duration:</strong> ${(durationMs / 1000).toFixed(1)}s</p>
      <p><strong>Log file:</strong> <code>${escapeHtml(logPath)}</code></p>
      <h3>Last lines of stderr</h3>
      <pre style="background:#f5f5f5; padding:12px; overflow:auto; font-size:12px; line-height:1.4;">${escapeHtml(stderrTail) || '(empty)'}</pre>
      <p style="color:#666; font-size:12px;">LeszyRun daily pipeline · sent ${new Date().toISOString()}</p>
    </div>
  `;
  return send({ subject, html });
}

export async function sendNoOutputEmail({ rowsCreated, rowsUpdated, durationMs, logPath }) {
  const subject = `[WARN] LeszyRun pipeline ran clean but 0 calendar_events rows changed`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 720px; margin: 0 auto;">
      <h2 style="color: #f59e0b;">⚠️ Pipeline produced no output</h2>
      <p>All 11 steps exited 0, but no rows in <code>calendar_events</code> were created or updated today.</p>
      <ul>
        <li>Rows created today: <strong>${rowsCreated}</strong></li>
        <li>Rows updated today: <strong>${rowsUpdated}</strong></li>
        <li>Total duration: <strong>${(durationMs / 1000 / 60).toFixed(1)} min</strong></li>
      </ul>
      <p><strong>Log file:</strong> <code>${escapeHtml(logPath)}</code></p>
      <p>Likely causes: Supabase down, all source sites had no new events, or <code>run-publish</code> silently no-oped.</p>
      <p style="color:#666; font-size:12px;">LeszyRun daily pipeline · sent ${new Date().toISOString()}</p>
    </div>
  `;
  return send({ subject, html });
}

export async function sendMissedRunEmail({ reason, lastSeenAt }) {
  const subject = `[ALERT] LeszyRun pipeline did not run`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 720px; margin: 0 auto;">
      <h2 style="color: #dc2626;">⏰ Pipeline missed its run</h2>
      <p>The 10:00 watchdog found no fresh heartbeat from the daily pipeline.</p>
      <ul>
        <li><strong>Reason:</strong> ${escapeHtml(reason)}</li>
        <li><strong>Last successful run:</strong> ${lastSeenAt ? escapeHtml(lastSeenAt) : '(never)'}</li>
      </ul>
      <p>Most likely the laptop or Docker Desktop was off at 08:00. To run manually:</p>
      <pre style="background:#f5f5f5; padding:12px;">docker compose exec scheduler npm run pipeline</pre>
      <p style="color:#666; font-size:12px;">LeszyRun watchdog · sent ${new Date().toISOString()}</p>
    </div>
  `;
  return send({ subject, html });
}
