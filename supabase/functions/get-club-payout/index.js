import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { clubRole, clubRegistrationEnabled } from '../_shared/organizer.js'
import { maskIban } from '../_shared/maskIban.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// Payout details for the club settings page. The owner gets every field to
// edit; an admin gets the name and a masked account number; anyone else 403.
// A club without online registration (registration_enabled = false) answers 404.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const session = await getSession(req, admin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try {
    const { clubId } = await req.json()
    if (!clubId) return json({ error: 'clubId required' }, 400, req)

    const role = await clubRole(admin, clubId, session.userId)
    if (role !== 'owner' && role !== 'admin') return json({ error: 'Brak uprawnień.' }, 403, req)
    // Role first, so a non-member cannot probe enablement; a club without online registration has no payout section.
    if (!(await clubRegistrationEnabled(admin, clubId))) return json({ error: 'Not found' }, 404, req)

    const { data: row, error } = await admin.from('club_payout_details')
      .select('legal_name, nip, krs, iban, address').eq('club_id', clubId).maybeSingle()
    if (error) throw error
    if (!row) return json({ data: null }, 200, req)

    if (role === 'admin') {
      return json({ data: { legalName: row.legal_name, ibanMasked: maskIban(row.iban) } }, 200, req)
    }
    return json({ data: {
      legalName: row.legal_name, nip: row.nip, krs: row.krs, iban: row.iban, address: row.address,
    } }, 200, req)
  } catch (err) {
    // Never the whole error: PostgREST details can echo the IBAN or NIP.
    console.error('get-club-payout error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
