// One way out for transactional email.
//   EMAIL_CAPTURE_URL set  -> POST the message there (local test stack only)
//   SENDGRID_API_KEY set   -> SendGrid, text + html parts
//   neither                -> does nothing (the code/link is still stored in the DB)
// A non-2xx answer (SendGrid or the capture server) is logged, not thrown, and an
// unreachable capture server is swallowed. A network failure reaching SendGrid DOES
// throw (the fetch rejects): callers that treat email as best effort wrap the call
// (update-club-payout, join-registration-waitlist); auth-request-code lets it become
// a 500, as it always did.
export function emailConfigured() {
  return Boolean(Deno.env.get('EMAIL_CAPTURE_URL') || Deno.env.get('SENDGRID_API_KEY'))
}

export async function sendEmail({ to, subject, text, html, replyTo, fromName = 'LESZY.RUN' }) {
  const captureUrl = Deno.env.get('EMAIL_CAPTURE_URL')
  if (captureUrl) {
    try {
      const res = await fetch(captureUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, text, html, replyTo, fromName }),
      })
      if (!res.ok) console.error('Email capture error:', res.status)
    } catch (err) {
      console.error('Email capture unreachable:', err)
    }
    return
  }

  const apiKey = Deno.env.get('SENDGRID_API_KEY')
  if (!apiKey) return

  const body = {
    personalizations: [{ to: [{ email: to }] }],
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
}
