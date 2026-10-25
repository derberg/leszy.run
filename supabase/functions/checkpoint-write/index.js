// The only writer of checkpoint_observations and checkpoint_agents. Volunteers
// (public/src/hooks/useCheckpointOutbox.js) and Pi agents
// (checkpoint-agent/src/edgeWriter.js) both used to insert with the publishable
// key, under a policy that let anyone do the same. Anybody could pre-fill every
// bib at every checkpoint, and because the first row wins
// UNIQUE(checkpoint_id, bib_number), the real passes were then dropped.
//
// Auth is the event's checkpoint_pin, the secret the Pi agents already use for
// checkpoint-roster. Body: { action, checkpoint_id, pin, ... }
//   verify    → 200 { data: { ok: true } }            (volunteer PIN screen)
//   observe   → 200 { data: [{ id }] } saved, { data: [] } dropped by the
//               rfid-over-manual trigger, 409 { code: '23505' } already there
//   heartbeat → 200 { data: null }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { checkEventPin } from '../_shared/pinGuard.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SOURCES = new Set(['manual', 'rfid'])
const AGENT_STATUS_MAX = 40

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

function count(v) {
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/** @returns {{ row: object } | { error: string }} */
function observationRow(checkpointId, o) {
  if (!o || typeof o !== 'object') return { error: 'observation is required' }
  const bib = Number(o.bib_number)
  if (!Number.isInteger(bib) || bib < 1 || bib > 99999) return { error: 'Invalid bib_number' }
  const observedAt = new Date(o.observed_at)
  if (typeof o.observed_at !== 'string' || Number.isNaN(observedAt.getTime())) return { error: 'Invalid observed_at' }
  const source = o.source ?? 'manual'
  if (!SOURCES.has(source)) return { error: 'Invalid source' }
  const row = { checkpoint_id: checkpointId, bib_number: bib, observed_at: observedAt.toISOString(), source }
  if (o.id !== undefined && o.id !== null) {
    if (!UUID_RE.test(String(o.id))) return { error: 'Invalid id' }
    row.id = o.id
  }
  return { row }
}

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, req)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }
  const { action, checkpoint_id: checkpointId, pin } = body ?? {}
  if (!['verify', 'observe', 'heartbeat'].includes(action)) return json({ error: 'Invalid action' }, 400, req)
  if (!UUID_RE.test(String(checkpointId ?? ''))) return json({ error: 'Invalid checkpoint_id' }, 400, req)
  if (!pin) return json({ error: 'pin is required' }, 400, req)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data: checkpoint, error: cpErr } = await admin
    .from('checkpoints').select('id, event_id').eq('id', checkpointId).maybeSingle()
  if (cpErr) return json({ error: 'Lookup failed' }, 500, req)
  if (!checkpoint) return json({ error: 'Checkpoint not found', code: 'not_found' }, 404, req)

  const check = await checkEventPin(admin, { eventId: checkpoint.event_id, column: 'checkpoint_pin', pin: String(pin) })
  if (!check.ok) {
    return json({ error: check.error, code: check.status === 401 ? 'invalid_pin' : '' }, check.status, req)
  }

  if (action === 'verify') return json({ data: { ok: true } }, 200, req)

  if (action === 'heartbeat') {
    const now = new Date().toISOString()
    const { error } = await admin.from('checkpoint_agents').upsert({
      checkpoint_id: checkpointId,
      status: String(body.status ?? '').slice(0, AGENT_STATUS_MAX),
      reads_total: count(body.reads_total),
      queue_pending: count(body.queue_pending),
      unknown_count: count(body.unknown_count),
      last_seen_at: now,
      updated_at: now,
    }, { onConflict: 'checkpoint_id' })
    if (error) return json({ error: 'Heartbeat failed', code: '' }, 500, req)
    return json({ data: null }, 200, req)
  }

  const parsed = observationRow(checkpointId, body.observation)
  if (parsed.error) return json({ error: parsed.error, code: 'invalid_observation' }, 400, req)

  // .select() is what makes a dropped row visible: the
  // trg_checkpoint_obs_priority BEFORE INSERT trigger returns NULL when the
  // (checkpoint_id, bib_number) slot is taken, and the insert then reports no
  // error and no row.
  const { data, error } = await admin.from('checkpoint_observations').insert(parsed.row).select('id')
  if (error?.code === '23505') return json({ error: 'Already recorded', code: '23505' }, 409, req)
  if (error) {
    console.error('[checkpoint-write] insert failed', error)
    return json({ error: 'Insert failed', code: '' }, 500, req)
  }
  return json({ data }, 200, req)
})
