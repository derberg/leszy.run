// supabase/functions/delete-my-account/index.js
// GDPR Art. 17 — right of erasure.
// Two-step flow:
//   POST { action: 'request' }           → issues OTP, sends email, returns { sent: true }
//   POST { action: 'confirm', code: '…' } → validates OTP, soft-deletes profile, bans auth user, returns { deleted: true }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function json(body, status, req, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...extraHeaders },
  })
}

async function sendDeletionEmail(email, code) {
  const apiKey = Deno.env.get('SENDGRID_API_KEY')
  if (!apiKey) {
    console.warn('SENDGRID_API_KEY not set — deletion confirmation email not sent (code stored in DB)')
    return
  }

  const plainText = `Potwierdzenie usunięcia konta na Leszy.run\n\nTwój kod potwierdzający:\n\n${code}\n\nKod jest ważny przez 10 minut.\n\nJeśli to nie Ty złożyłeś to żądanie, zignoruj tę wiadomość — Twoje konto pozostanie niezmienione.\n\nLeszy.run — kalendarz biegów w Polsce\nhttps://www.leszy.run`
  const html = `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Potwierdź usunięcie konta</title>
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
              <p style="margin:0 0 8px 0;font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#8886a0;">Usunięcie konta</p>
              <h1 style="margin:0 0 24px 0;font-size:22px;font-weight:800;line-height:1.3;color:#1a1a28;letter-spacing:-0.01em;">
                Potwierdź usunięcie konta na Leszy.run
              </h1>
              <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#525266;">
                Otrzymaliśmy żądanie usunięcia Twojego konta. Aby potwierdzić tę operację, wpisz poniższy kod w aplikacji.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 32px 8px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="background:#0A0A10;border:2px solid #EF4444;padding:24px 40px;">
                    <div style="font-family:'Courier New',Courier,monospace;font-size:40px;font-weight:700;letter-spacing:0.32em;color:#EF4444;line-height:1;text-align:center;">${code}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 8px 32px;">
              <p style="margin:0;font-size:14px;line-height:1.6;color:#525266;">
                Kod jest ważny przez <strong style="color:#1a1a28;">10 minut</strong>. Po potwierdzeniu konto zostanie usunięte nieodwracalnie.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 32px 32px;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#8886a0;border-top:1px solid #e5e5ea;padding-top:16px;">
                Jeśli to nie Ty złożyłeś to żądanie, zignoruj tę wiadomość. Twoje konto pozostanie niezmienione.
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
      personalizations: [{ to: [{ email }] }],
      from: { email: Deno.env.get('SENDGRID_FROM_EMAIL'), name: 'Łukasz z LESZY.RUN' },
      subject: `${code} — Potwierdź usunięcie konta na Leszy.run`,
      content: [
        { type: 'text/plain', value: plainText },
        { type: 'text/html', value: html },
      ],
    }),
  })
  if (!sgRes.ok) {
    console.error('SendGrid error:', await sgRes.text())
  }
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, req)
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) {
    return json({ error: 'Unauthorized' }, 401, req)
  }

  // GDPR/club-ownership guard: a club must have a living owner. Block deletion
  // entirely (both the `request` and `confirm` steps) until ownership is
  // transferred or the club is deleted — otherwise the club is left orphaned.
  const { data: ownedClubs } = await supabaseAdmin
    .from('clubs')
    .select('id, name')
    .eq('owner_id', session.userId)
  if (ownedClubs && ownedClubs.length) {
    return json({
      error: 'Jesteś właścicielem klubu. Przekaż własność albo usuń klub, zanim usuniesz konto.',
      clubs: ownedClubs.map(({ id, name }) => ({ id, name })),
    }, 409, req)
  }

  let body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400, req)
  }

  const { action } = body

  // ── action: request ────────────────────────────────────────────────────────
  if (action === 'request') {
    // Get profile email (session.email is the session-time email; double-check profile hasn't been deleted)
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('email')
      .eq('id', session.userId)
      .is('deleted_at', null)
      .single()

    if (profileError || !profile?.email) {
      return json({ error: 'Profile not found or already deleted' }, 404, req)
    }

    const normalizedEmail = profile.email.toLowerCase().trim()

    // Invalidate any previous unused delete_account codes for this email
    await supabaseAdmin
      .from('auth_codes')
      .update({ used: true })
      .eq('email', normalizedEmail)
      .eq('purpose', 'delete_account')
      .eq('used', false)

    // Generate OTP
    const codeArr = new Uint32Array(1)
    crypto.getRandomValues(codeArr)
    const code = String(100000 + (codeArr[0] % 900000))
    const codeHash = await sha256hex(code)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    const { error: insertError } = await supabaseAdmin
      .from('auth_codes')
      .insert({ email: normalizedEmail, code_hash: codeHash, expires_at: expiresAt, purpose: 'delete_account' })
    if (insertError) {
      console.error('auth_codes insert error:', insertError)
      return json({ error: 'Failed to issue code' }, 500, req)
    }

    await sendDeletionEmail(normalizedEmail, code)

    return json({ sent: true }, 200, req)
  }

  // ── action: confirm ────────────────────────────────────────────────────────
  if (action === 'confirm') {
    const rawCode = body.code
    if (typeof rawCode !== 'string' || !/^\d{6}$/.test(rawCode.trim())) {
      return json({ error: 'Missing or invalid code' }, 400, req)
    }
    const trimmedCode = rawCode.trim()

    // Get profile (need email BEFORE we null it)
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, email')
      .eq('id', session.userId)
      .is('deleted_at', null)
      .single()

    if (profileError || !profile) {
      return json({ error: 'Profile not found or already deleted' }, 404, req)
    }

    const normalizedEmail = profile.email ? profile.email.toLowerCase().trim() : null
    if (!normalizedEmail) {
      return json({ error: 'No email on profile' }, 400, req)
    }

    // Validate OTP
    const now = new Date().toISOString()
    const { data: codes } = await supabaseAdmin
      .from('auth_codes')
      .select('id, code_hash, attempts')
      .eq('email', normalizedEmail)
      .eq('purpose', 'delete_account')
      .eq('used', false)
      .gt('expires_at', now)
      .order('created_at', { ascending: false })
      .limit(1)

    const otpRow = codes?.[0]
    if (!otpRow) {
      return json({ error: 'Invalid or expired code' }, 401, req)
    }

    if (otpRow.attempts >= 3) {
      return json({ error: 'Too many attempts. Request a new code.' }, 403, req)
    }

    // Increment attempts before checking hash (rate-limit even on wrong guesses)
    await supabaseAdmin
      .from('auth_codes')
      .update({ attempts: otpRow.attempts + 1 })
      .eq('id', otpRow.id)

    const incomingHash = await sha256hex(trimmedCode)
    if (incomingHash !== otpRow.code_hash) {
      return json({ error: 'Invalid or expired code' }, 401, req)
    }

    // Mark OTP used
    await supabaseAdmin.from('auth_codes').update({ used: true }).eq('id', otpRow.id)

    // ── Soft-delete: capture email FIRST, then null PII ──────────────────────
    const originalEmail = normalizedEmail

    // 1. Anonymize participants matching original email
    const participantsResult = await supabaseAdmin
      .from('participants')
      .update({
        first_name: 'Uczestnik',
        last_name: 'anonimowy',
        phone: null,
        email: null,
        deleted_at: new Date().toISOString(),
      })
      .eq('email', originalEmail)

    if (participantsResult.error) {
      console.error('delete-my-account: participants anonymization failed for', originalEmail, participantsResult.error)
      // Soft-delete continues — profile-level deletion is the user's primary request and must not be blocked
      // by participant-side failures. The error is logged so a human can investigate orphan PII.
    }

    // 2. Soft-delete profile (username must be unique — use first 8 chars of UUID)
    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({
        email: null,
        username: 'usuniety-' + profile.id.slice(0, 8),
        display_name: 'Uczestnik anonimowy',
        phone: null,
        date_of_birth: null,
        gender: null,
        city: null,
        voivodeship: null,
        club_id: null,
        deleted_at: new Date().toISOString(),
      })
      .eq('id', profile.id)

    if (updateError) {
      console.error('profile soft-delete error:', updateError)
      return json({ error: 'Failed to delete account' }, 500, req)
    }

    // 2b. Erase event favorites (soft delete on profile never fires FK cascade — GDPR erasure)
    const { error: favError } = await supabaseAdmin.from('event_favorites').delete().eq('user_id', session.userId)
    // Profile is already soft-deleted at this point; log and continue rather than
    // fail the whole deletion — favorites can be swept manually if this ever fires.
    if (favError) console.error('delete-my-account: favorites cleanup failed:', favError.message)

    // 3. Permanently ban auth user (email on auth.users is NOT rotated — stays claimed, blocks re-registration)
    const { error: banError } = await supabaseAdmin.auth.admin.updateUserById(session.userId, {
      ban_duration: '876000h',
    })
    if (banError) {
      // Non-fatal: profile is already soft-deleted; log and continue
      console.error('auth ban error (non-fatal, profile already deleted):', banError)
    }

    return json({ deleted: true }, 200, req)
  }

  // ── unknown action ─────────────────────────────────────────────────────────
  return json({ error: 'Invalid action. Expected "request" or "confirm".' }, 400, req)
})
