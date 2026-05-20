import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function json(body, status, req, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...extraHeaders },
  })
}

const SESSION_MAX_AGE = 60 * 24 * 60 * 60 // 60 days in seconds

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  try {
    const { email, code } = await req.json()

    if (!email || !code || !/^\d{6}$/.test(String(code).trim())) {
      return json({ error: 'Nieprawidłowe dane.' }, 400, req)
    }

    const normalizedEmail = email.toLowerCase().trim()
    const trimmedCode = String(code).trim()
    const now = new Date().toISOString()

    const { data: codes } = await supabaseAdmin
      .from('auth_codes')
      .select('id, code_hash, attempts')
      .eq('email', normalizedEmail)
      .eq('used', false)
      .gt('expires_at', now)
      .order('created_at', { ascending: false })
      .limit(1)

    const loginCode = codes?.[0]
    if (!loginCode) {
      return json({ error: 'Kod wygasł lub nie istnieje. Poproś o nowy.' }, 400, req)
    }

    if (loginCode.attempts >= 3) {
      return json({ error: 'Przekroczono liczbę prób. Poproś o nowy kod.' }, 403, req)
    }

    await supabaseAdmin
      .from('auth_codes')
      .update({ attempts: loginCode.attempts + 1 })
      .eq('id', loginCode.id)

    const incomingHash = await sha256hex(trimmedCode)
    if (incomingHash !== loginCode.code_hash) {
      return json({ error: 'Nieprawidłowy kod.' }, 401, req)
    }

    await supabaseAdmin.from('auth_codes').update({ used: true }).eq('id', loginCode.id)

    // Find or create profile
    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, username')
      .eq('email', normalizedEmail)
      .maybeSingle()

    let profile = existingProfile
    if (!profile) {
      const newId = crypto.randomUUID()
      const { data: newProfile, error: insertError } = await supabaseAdmin
        .from('profiles')
        .insert({ id: newId, email: normalizedEmail })
        .select('id, username')
        .single()
      if (insertError) throw insertError
      profile = newProfile
    }

    // Create session
    const sessionToken = randomToken()
    const sessionExpires = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString()

    const { error: sessionError } = await supabaseAdmin
      .from('auth_sessions')
      .insert({ id: sessionToken, user_id: profile.id, email: normalizedEmail, expires_at: sessionExpires })
    if (sessionError) throw sessionError

    const cookie = `leszy_session=${sessionToken}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_MAX_AGE}`

    const hasUsername = Boolean(profile.username)

    return json(
      { success: true, hasUsername },
      200,
      req,
      { 'Set-Cookie': cookie }
    )
  } catch (err) {
    console.error(err)
    return json({ error: 'Błąd serwera.' }, 500, req)
  }
})
