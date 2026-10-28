// One way out for transactional email.
//   EMAIL_CAPTURE_URL set  -> POST the message there (local test stack only)
//   SENDGRID_API_KEY set   -> SendGrid, text + html parts
//   neither                -> does nothing (the code/link is still stored in the DB)
// Never throws on a delivery failure: callers treat email as best effort, as
// auth-request-code always did.
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
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html', value: html },
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
