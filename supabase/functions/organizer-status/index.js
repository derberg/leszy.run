import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

import { clubRole, clubRegistrationEnabled, ORGANIZER_AGREEMENT_VERSION } from '../_shared/organizer.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

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
    if (!role) return json({ error: 'Nie należysz do tego klubu.' }, 403, req)

    const [enabled, waitlist, agreement, payout] = await Promise.all([
      clubRegistrationEnabled(admin, clubId),
      admin.from('registration_waitlist').select('club_id').eq('club_id', clubId).maybeSingle(),
      admin.from('organizer_agreements').select('id').eq('club_id', clubId).eq('version', ORGANIZER_AGREEMENT_VERSION).limit(1),
      admin.from('club_payout_details').select('club_id').eq('club_id', clubId).maybeSingle(),
    ])
    return json({ data: {
      enabled,
      waitlisted: !!waitlist.data,
      agreementAccepted: (agreement.data?.length ?? 0) > 0,
      version: ORGANIZER_AGREEMENT_VERSION,
      payoutConfigured: !!payout.data,
      role,
    } }, 200, req)
  } catch (err) {
    console.error('organizer-status error:', err)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
