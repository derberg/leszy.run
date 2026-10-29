// PIN-guarded roster download for checkpoint-agent devices (Raspberry Pi RFID
// readers). Returns ONLY bib_number + rfid_epc — never names or personal data;
// the roster lives on a Pi in a forest. Auth: per-event checkpoint_pin from
// event_secrets, the same PIN the volunteer links carry for checkpoint-write.
// Whoever holds a volunteer link can therefore download bib→EPC pairs; no
// names or contact data ever leave here.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { checkCheckpointPin } from '../_shared/pinGuard.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, req)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }
  const { event_id, pin } = body ?? {}
  if (!event_id || !pin) return json({ error: 'event_id and pin are required' }, 400, req)
  if (!UUID_RE.test(String(event_id))) return json({ error: 'Invalid event_id' }, 400, req)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const check = await checkCheckpointPin(admin, { eventId: event_id, pin: String(pin) })
  if (!check.ok) return json({ error: check.error }, check.status, req)

  const { data: roster, error: rosterErr } = await admin
    .from('participants')
    .select('bib_number, rfid_epc')
    .eq('event_id', event_id)
    .not('rfid_epc', 'is', null)
    .not('bib_number', 'is', null)
    .is('deleted_at', null)
    .is('removed_at', null)
  if (rosterErr) return json({ error: 'Roster query failed' }, 500, req)

  return json({ data: roster }, 200, req)
})
