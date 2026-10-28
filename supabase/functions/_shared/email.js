// One way out for transactional email.
//   EMAIL_CAPTURE_URL set  -> POST the message there (local test stack only)
//   SENDGRID_API_KEY set   -> SendGrid, text part (+ html part when given)
//   neither                -> does nothing (the code/link is still stored in the DB)
// Both senders resolve to { ok, status }: a non-2xx answer (SendGrid or the
// capture server) is logged and reported as ok: false, an unreachable capture
// server as status 0, nothing configured as ok: false, status 0. Callers that
// treat email as best effort ignore the result, as they always did. A network
// failure reaching SendGrid DOES throw (the fetch rejects): those callers wrap
// the call (update-club-payout, join-registration-waitlist); auth-request-code
// lets it become a 500, as it always did.
import { sendInBatches } from './emailBatch.js'

export function emailConfigured() {
  return Boolean(Deno.env.get('EMAIL_CAPTURE_URL') || Deno.env.get('SENDGRID_API_KEY'))
}

// to: one address, or a list sent as one request with a personalization per
// address (at most 1000, SendGrid's limit), so nobody sees the others.
async function send({ to, subject, text, html, replyTo, fromName = 'LESZY.RUN' }) {
  const captureUrl = Deno.env.get('EMAIL_CAPTURE_URL')
  if (captureUrl) {
    try {
      const res = await fetch(captureUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, text, html, replyTo, fromName }),
      })
      if (!res.ok) console.error('Email capture error:', res.status)
      return { ok: res.ok, status: res.status }
    } catch (err) {
      console.error('Email capture unreachable:', err)
      return { ok: false, status: 0 }
    }
  }

  const apiKey = Deno.env.get('SENDGRID_API_KEY')
  if (!apiKey) return { ok: false, status: 0 }

  const body = {
    personalizations: (Array.isArray(to) ? to : [to]).map((email) => ({ to: [{ email }] })),
    from: { email: Deno.env.get('SENDGRID_FROM_EMAIL'), name: fromName },
    subject,
    // Organizer messages are plain text only (spec 12.10): no html part then.
    content: [
      { type: 'text/plain', value: text },
      ...(html ? [{ type: 'text/html', value: html }] : []),
    ],
  }
  if (replyTo) body.reply_to = { email: replyTo }

  const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!sgRes.ok) console.error('SendGrid error:', await sgRes.text())
  return { ok: sgRes.ok, status: sgRes.status }
}

/** One message to one address. → { ok, status } */
export function sendEmail(message) {
  return send({ ...message, to: String(message.to) })
}

/** One message to many addresses, 1000 per request. → { sent, failed, batches } */
export function sendBulkEmail(recipients, message) {
  return sendInBatches(recipients, (batch) => send({ ...message, to: batch }))
}
