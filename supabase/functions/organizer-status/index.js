import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

import { AGREEMENT_CHANGES, clubRole, clubRegistrationEnabled, ORGANIZER_AGREEMENT_VERSION } from '../_shared/organizer.js'
import { organizerIdentityReady } from '../_shared/registration/eventPayout.js'

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
      // Any accepted version is the agreement (§13 ust. 6): a later version is an update with a notice
      // e-mail, never a re-acceptance. The newest acceptance first.
      admin.from('organizer_agreements').select('version, accepted_at').eq('club_id', clubId)
        .order('accepted_at', { ascending: false }).order('id', { ascending: false }).limit(1),
      admin.from('club_payout_details').select('legal_name, nip, address').eq('club_id', clubId).maybeSingle(),
    ])
    return json({ data: {
      enabled,
      waitlisted: !!waitlist.data,
      agreementAccepted: (agreement.data?.length ?? 0) > 0,
      agreementAcceptedAt: agreement.data?.[0]?.accepted_at ?? null,
      // The newest version the club accepted (null: none) and the current one; when they differ the
      // panel shows the „Zaktualizowaliśmy umowę” strip with the change list.
      acceptedVersion: agreement.data?.[0]?.version ?? null,
      currentVersion: ORGANIZER_AGREEMENT_VERSION,
      version: ORGANIZER_AGREEMENT_VERSION,
      agreementChanges: AGREEMENT_CHANGES,
      // The Organizer is named; the account number may still be missing.
      payoutConfigured: organizerIdentityReady(payout.data),
      role,
    } }, 200, req)
  } catch (err) {
    console.error('organizer-status error:', err)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
