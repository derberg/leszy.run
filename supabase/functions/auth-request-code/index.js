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
      const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: normalizedEmail }] }],
          from: { email: Deno.env.get('SENDGRID_FROM_EMAIL') },
          subject: 'Twój kod logowania — Leszy.run',
          content: [{
            type: 'text/plain',
            value: `Twój kod logowania do Leszy.run:\n\n${code}\n\nKod jest ważny przez 10 minut. Jeśli to nie Ty, zignoruj tę wiadomość.`,
          }],
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
