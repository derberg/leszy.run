// PIN-guarded roster download for checkpoint-agent devices (Raspberry Pi RFID
// readers). Returns ONLY bib_number + rfid_epc — never names or personal data;
// the roster lives on a Pi in a forest. Auth: per-event checkpoint_pin from
// event_secrets (NOT the check-in PIN, which participants know).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// In-memory per-IP throttle (instance-local; good enough to stop dumb brute force)
const attempts = new Map() // ip -> { count, windowStart }
const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 5

function throttled(ip) {
  const now = Date.now()
  const entry = attempts.get(ip)
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attempts.set(ip, { count: 1, windowStart: now })
    return false
  }
  entry.count += 1
  return entry.count > MAX_ATTEMPTS
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, req)

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
  if (throttled(ip)) return json({ error: 'Too many attempts' }, 429, req)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }
  const { event_id, pin } = body ?? {}
  if (!event_id || !pin) return json({ error: 'event_id and pin are required' }, 400, req)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data: secret, error: secErr } = await admin
    .from('event_secrets').select('checkpoint_pin').eq('event_id', event_id).maybeSingle()
  if (secErr) return json({ error: 'Lookup failed' }, 500, req)
  if (!secret?.checkpoint_pin || secret.checkpoint_pin !== String(pin)) {
    return json({ error: 'Invalid PIN' }, 401, req)
  }

  const { data: roster, error: rosterErr } = await admin
    .from('participants')
    .select('bib_number, rfid_epc')
    .eq('event_id', event_id)
    .not('rfid_epc', 'is', null)
    .not('bib_number', 'is', null)
    .is('deleted_at', null)
  if (rosterErr) return json({ error: 'Roster query failed' }, 500, req)

  return json({ data: roster }, 200, req)
})
