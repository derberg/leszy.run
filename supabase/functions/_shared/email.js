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
// lets it become a 500, as it always did. SendGrid gets SENDGRID_TIMEOUT_MS, and
// what it throws carries `deliveryUnknown: true` (postToSendGrid).
import { sendInBatches } from './emailBatch.js'

export function emailConfigured() {
  return Boolean(Deno.env.get('EMAIL_CAPTURE_URL') || Deno.env.get('SENDGRID_API_KEY'))
}

// The local test stack only. A connection from the edge-runtime container to the host sometimes
// stalls before the request is sent, for 3 to 68 s (tests/registration/README.md), and the capture
// server answers in milliseconds. So a request with no answer after timeoutMs was never delivered,
// and sending it again on a new connection cannot duplicate it. Only a stall is retried: an answer,
// or a refused connection, is the result.
export async function postToCapture(url, init, { timeoutMs = 2000, tries = 4, fetchFn = fetch } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      if (err?.name !== 'TimeoutError' || attempt >= tries) throw err
      console.warn(`Email capture: no answer in ${timeoutMs} ms (try ${attempt}), retrying`)
    }
  }
}

// A provider that stalls must not hold a request open until the isolate is killed: dpay-ipn and
// team-squad await their mail (final review I-4).
export const SENDGRID_TIMEOUT_MS = 10_000

/**
 * One POST to SendGrid's mail/send, given up after timeoutMs and never retried. A rejection
 * (the timeout, or a connection that broke) carries `deliveryUnknown: true`: SendGrid may have
 * read the whole request and queued the mail before the answer was lost, and the API has no
 * idempotency key, so whoever sends again risks a second copy. An HTTP answer is the result.
 */
export async function postToSendGrid(body, apiKey, { timeoutMs = SENDGRID_TIMEOUT_MS, fetchFn = fetch } = {}) {
  try {
    return await fetchFn('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const wrapped = new Error(`SendGrid: ${err?.name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : err?.message ?? err}`, { cause: err })
    wrapped.deliveryUnknown = true
    throw wrapped
  }
}

// to: one address, or a list sent as one request with a personalization per
// address (at most 1000, SendGrid's limit), so nobody sees the others.
//
// noTracking: true switches SendGrid click tracking off for the message. Click tracking rewrites
// every link through SendGrid's redirect host, so a link that carries a secret (a login code, a
// single-use token, an id that opens a page) would pass through, and be logged by, a third party.
// Set it on every message whose link is a credential. Marketing and digest mail leave it off.
export function trackingSettings(noTracking) {
  return noTracking ? { click_tracking: { enable: false, enable_text: false } } : undefined
}

export function buildSendGridBody({ to, subject, text, html, replyTo, fromName = 'LESZY.RUN', noTracking = false }, fromEmail) {
  const body = {
    personalizations: (Array.isArray(to) ? to : [to]).map((email) => ({ to: [{ email }] })),
    from: { email: fromEmail, name: fromName },
    subject,
    // Organizer messages are plain text only (spec 12.10): no html part then.
    content: [
      { type: 'text/plain', value: text },
      ...(html ? [{ type: 'text/html', value: html }] : []),
    ],
  }
  if (replyTo) body.reply_to = { email: replyTo }
  const tracking = trackingSettings(noTracking)
  if (tracking) body.tracking_settings = tracking
  return body
}

// Rebase shim (Plan 7 used `trackClicks: false`); removed once every caller passes noTracking.
export function sendGridBody({ trackClicks = true, ...rest }, fromEmail) {
  return buildSendGridBody({ ...rest, noTracking: rest.noTracking || trackClicks === false }, fromEmail)
}

async function send({ to, subject, text, html, replyTo, fromName = 'LESZY.RUN', noTracking: noTrackingArg = false, trackClicks = true }) {
  const noTracking = noTrackingArg || trackClicks === false
  const captureUrl = Deno.env.get('EMAIL_CAPTURE_URL')
  if (captureUrl) {
    try {
      const res = await postToCapture(captureUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, text, html, replyTo, fromName, noTracking, ...(noTracking ? { trackClicks: false } : {}) }),
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

  const body = buildSendGridBody({ to, subject, text, html, replyTo, fromName, noTracking }, Deno.env.get('SENDGRID_FROM_EMAIL'))

  const sgRes = await postToSendGrid(body, apiKey)
  if (!sgRes.ok) console.error('SendGrid error:', await sgRes.text())
  return { ok: sgRes.ok, status: sgRes.status }
}

/** One message to one address. → { ok, status } */
export function sendEmail(message) {
  return send({ ...message, to: String(message.to) })
}

/**
 * One message to a few addresses in ONE request, a personalization each (nobody sees the others).
 * → { ok, status }; throws like sendEmail (a SendGrid timeout carries `deliveryUnknown`). For a
 * handful of addresses that must succeed or fail together; mass mail is sendBulkEmail.
 */
export function sendEmailToEach(addresses, message) {
  return send({ ...message, to: addresses.map(String) })
}

/** One message to many addresses, 1000 per request. → { sent, failed, batches } */
export function sendBulkEmail(recipients, message) {
  return sendInBatches(recipients, (batch) => send({ ...message, to: batch }))
}
