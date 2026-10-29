import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { maskIban } from '../_shared/maskIban.js'
import { loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// POST { eventId } → the event's payout account, for the Płatności step.
// Mirrors get-club-payout (ruling P3-R1): the club owner gets every field
// to edit, an admin the mode, the recipient and the account masked as
// „PL61 … 2874”, a member 403; an outsider or a disabled club 404. No row
// means the club's own account: { mode: 'club' } with no event-level fields.
// This is the only read of event_payout_details.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const session = await getSession(req, admin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  try {
    const loaded = await loadOrganizerEvent(admin, body?.eventId, session, { write: true, req })
    if (loaded instanceof Response) return loaded
    const { settings, role } = loaded

    const { data: row, error } = await admin.from('event_payout_details')
      .select('payout_mode, payout_recipient, payout_tax_id, payout_iban, payout_title')
      .eq('event_id', settings.event_id).maybeSingle()
    if (error) throw error
    const mode = row?.payout_mode ?? 'club'

    if (role !== 'owner') {
      return json({ data: { mode, recipient: row?.payout_recipient ?? null, ibanMasked: maskIban(row?.payout_iban) } }, 200, req)
    }
    return json({ data: {
      mode,
      recipient: row?.payout_recipient ?? null,
      taxId: row?.payout_tax_id ?? null,
      iban: row?.payout_iban ?? null,
      title: row?.payout_title ?? null,
    } }, 200, req)
  } catch (err) {
    // Never the whole error: PostgREST details can echo the IBAN or NIP.
    console.error('get-event-payout error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
