import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// Pick the base URL for the magic link from the request Origin (validated against
// our allowlist) so previews work too. Falls back to production www.leszy.run.
const STATIC_ORIGINS = ['http://localhost:5173', 'https://www.leszy.run', 'https://leszy.run']
const PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+-derbergs-projects\.vercel\.app$/
function magicLinkBase(req) {
  const origin = req.headers.get('Origin') ?? ''
  if (STATIC_ORIGINS.includes(origin) || PREVIEW_ORIGIN_RE.test(origin)) return origin
  return 'https://www.leszy.run'
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  try {
    const { email, honeypot } = await req.json()

    if (honeypot) return json({ success: true }, 200, req)

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Nieprawidłowy adres email.' }, 400, req)
    }

    const normalizedEmail = email.toLowerCase().trim()

    // Invalidate previous unused codes for this email
    await supabaseAdmin
      .from('auth_codes')
      .update({ used: true })
      .eq('email', normalizedEmail)
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

    const apiKey = Deno.env.get('SENDGRID_API_KEY')
    if (apiKey) {
      const linkBase = magicLinkBase(req)
      const magicLink = `${linkBase}/login?email=${encodeURIComponent(normalizedEmail)}&code=${code}`
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

      const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: normalizedEmail }] }],
          from: { email: Deno.env.get('SENDGRID_FROM_EMAIL'), name: 'Leszy.run' },
          subject: `${code} — Twój kod logowania do Leszy.run`,
          content: [
            { type: 'text/plain', value: plainText },
            { type: 'text/html', value: html },
          ],
        }),
      })
      if (!sgRes.ok) {
        console.error('SendGrid error:', await sgRes.text())
      }
    } else {
      console.warn('SENDGRID_API_KEY not set — email not sent (code stored in DB)')
    }

    return json({ success: true }, 200, req)
  } catch (err) {
    console.error(err)
    return json({ error: 'Błąd serwera. Spróbuj ponownie.' }, 500, req)
  }
})
