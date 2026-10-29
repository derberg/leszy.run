// Issuing a login code by e-mail, shared by auth-request-code and any form that logs a person
// in on the way (consent-request, Plan 4), as verifyCode.js is for checking one. The caller
// validates the address; this refuses a retired one, applies the per-address (5) and per-IP (20)
// limits of a 15-minute window, invalidates the address's earlier unused login codes, stores the
// new one as a SHA-256 and mails it. It never builds a Response. A database failure throws, and
// the caller answers 500.
import { checkAndIncrement } from './throttle.js'
import { isEmailRetired, RETIRED_EMAIL_MESSAGE } from './deletedEmails.js'
import { emailConfigured, sendEmail } from './email.js'

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra })

/** The login e-mail: the code, and a link to /login that signs in with one click. */
export function loginCodeEmail(code, magicLink) {
  const plainText = `Twój kod logowania do Leszy.run:\n\n${code}\n\nLub kliknij ten link, aby zalogować się od razu:\n${magicLink}\n\nKod jest ważny przez 10 minut. Jeśli to nie Ty, zignoruj tę wiadomość.\n\nLeszy.run — kalendarz biegów w Polsce\nhttps://www.leszy.run`
  const html = `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Twój kod logowania</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f4f6;padding:32px 16px;">
    <tr>
  <td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;background:#ffffff;border:1px solid #e5e5ea;">
      <tr>
        <td align="center" style="padding:0;">
          <a href="https://www.leszy.run" style="text-decoration:none;display:block;">
            <img src="https://www.leszy.run/og-image.png" alt="Leszy.run" width="520" style="display:block;width:100%;max-width:520px;height:auto;border:0;"/>
          </a>
        </td>
      </tr>
      <tr>
        <td style="padding:32px 32px 8px 32px;">
          <p style="margin:0 0 8px 0;font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#8886a0;">Kod logowania</p>
          <h1 style="margin:0 0 24px 0;font-size:22px;font-weight:800;line-height:1.3;color:#1a1a28;letter-spacing:-0.01em;">
            Wpisz ten kod, aby się zalogować
          </h1>
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:0 32px 8px 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td align="center" style="background:#0A0A10;border:2px solid #BBDD00;padding:24px 40px;">
                <div style="font-family:'Courier New',Courier,monospace;font-size:40px;font-weight:700;letter-spacing:0.32em;color:#BBDD00;line-height:1;text-align:center;">${code}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:24px 32px 8px 32px;">
          <p style="margin:0 0 12px 0;font-size:13px;line-height:1.5;color:#525266;">
            Albo zaloguj się jednym kliknięciem:
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td align="center" style="background:#BBDD00;">
                <a href="${magicLink}" style="display:inline-block;padding:14px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#0A0A10;text-decoration:none;">
                  Zaloguj się
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 32px 8px 32px;">
          <p style="margin:0;font-size:14px;line-height:1.6;color:#525266;">
            Kod i link są ważne przez <strong style="color:#1a1a28;">10 minut</strong>.
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 32px 32px 32px;">
          <p style="margin:0;font-size:12px;line-height:1.5;color:#8886a0;border-top:1px solid #e5e5ea;padding-top:16px;">
            Jeśli to nie Ty próbowałeś się zalogować, zignoruj tę wiadomość. Nikt nie uzyska dostępu do Twojego konta bez tego kodu.
          </p>
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:0 32px 24px 32px;">
          <p style="margin:0;font-size:11px;line-height:1.5;color:#8886a0;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">
            <a href="https://www.leszy.run" style="color:#8886a0;text-decoration:none;">Leszy.run</a>
            <span style="color:#cccccc;">&nbsp;·&nbsp;</span>
            <span>Kalendarz biegów w Polsce</span>
          </p>
        </td>
      </tr>
    </table>
  </td>
    </tr>
  </table>
</body>
</html>`

  return { subject: `${code} — Twój kod logowania do Leszy.run`, text: plainText, html }
}

/**
 * @param {object} supabaseAdmin
 * @param {{ email: string, ip?: string|null, linkBase: string, from?: string|null }} args
 *   email is already validated; linkBase is the site the magic link points at; from an internal
 *   path (sanitised by the caller) the login page goes on to.
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string, code?: string, retryAfterSec?: number }>}
 */
export async function requestLoginCode(supabaseAdmin, { email, ip = null, linkBase, from = null }) {
  const normalizedEmail = String(email).toLowerCase().trim()

  // A deleted account's address is retired for good — say so plainly instead
  // of mailing a code that would silently create a second, empty account
  // under the same address (see deletedEmails.js).
  if (await isEmailRetired(supabaseAdmin, normalizedEmail)) {
    return fail(403, RETIRED_EMAIL_MESSAGE, { code: 'email_retired' })
  }

  // Rate limiting: 5 requests per email and 20 per IP within a 15-minute window
  const emailThrottle = await checkAndIncrement(supabaseAdmin, `email:${normalizedEmail}`, 5)
  if (!emailThrottle.allowed) return fail(429, 'Too many requests', { retryAfterSec: emailThrottle.retryAfterSec })
  if (ip) {
    const ipThrottle = await checkAndIncrement(supabaseAdmin, `ip:${ip}`, 20)
    if (!ipThrottle.allowed) return fail(429, 'Too many requests', { retryAfterSec: ipThrottle.retryAfterSec })
  }

  // Invalidate previous unused LOGIN codes for this email. Scoped by purpose:
  // without it, asking for a login code silently killed a pending
  // account-deletion OTP (and vice versa, the two flows fought each other).
  await supabaseAdmin
    .from('auth_codes')
    .update({ used: true })
    .eq('email', normalizedEmail)
    .eq('purpose', 'login')
    .eq('used', false)

  const codeArr = new Uint32Array(1)
  crypto.getRandomValues(codeArr)
  const code = String(100000 + (codeArr[0] % 900000))
  const codeHash = await sha256hex(code)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  const { error: insertError } = await supabaseAdmin
    .from('auth_codes')
    .insert({ email: normalizedEmail, code_hash: codeHash, expires_at: expiresAt })
  if (insertError) throw insertError

  if (emailConfigured()) {
    const fromQs = from ? `&from=${encodeURIComponent(from)}` : ''
    const magicLink = `${linkBase}/login?email=${encodeURIComponent(normalizedEmail)}&code=${code}${fromQs}`
    await sendEmail({ to: normalizedEmail, ...loginCodeEmail(code, magicLink), fromName: 'Łukasz z LESZY.RUN' })
  } else {
    console.warn('No email transport configured — email not sent (code stored in DB)')
  }
  return { ok: true }
}
