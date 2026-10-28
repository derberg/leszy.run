import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

import { clubRole, clubRegistrationEnabled, logOrganizerAction } from '../_shared/organizer.js'
import { sendEmail } from '../_shared/email.js'

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
    if (role !== 'owner' && role !== 'admin') return json({ error: 'Brak uprawnień.' }, 403, req)

    if (await clubRegistrationEnabled(admin, clubId)) {
      return json({ data: { waitlisted: false, enabled: true } }, 200, req)
    }

    // Insert once: the primary key makes a second join a no-op, and only a
    // row that was really inserted emails the operator.
    const { data: inserted, error } = await admin.from('registration_waitlist')
      .upsert({ club_id: clubId, requested_by: session.userId }, { onConflict: 'club_id', ignoreDuplicates: true })
      .select('club_id')
    if (error) throw error

    if (inserted && inserted.length > 0) {
      await logOrganizerAction(admin, req, { actorId: session.userId, clubId, action: 'waitlist_joined' })
      // Best effort: the row is the record, the email only a nudge. sendEmail
      // logs HTTP failures itself but can still throw on a network error.
      try {
        const { data: club } = await admin.from('clubs').select('name, slug').eq('id', clubId).maybeSingle()
        const { data: who } = await admin.from('profiles').select('email').eq('id', session.userId).maybeSingle()
        const name = club?.name || clubId
        const text = `Klub "${name}" (${club?.slug || clubId}) dopisał się do listy oczekujących na zapisy online.\nZgłosił: ${who?.email || session.userId}`
        await sendEmail({
          to: Deno.env.get('PIPELINE_ALERT_EMAIL') || 'lpgornicki@gmail.com',
          subject: `[Zapisy] Lista oczekujących: ${name}`,
          text,
          html: `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`,
        })
      } catch (err) {
        console.error('join-registration-waitlist: operator email failed:', err)
      }
    }
    return json({ data: { waitlisted: true } }, 200, req)
  } catch (err) {
    console.error('join-registration-waitlist error:', err)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
