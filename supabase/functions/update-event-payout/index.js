import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { sendEmail } from '../_shared/email.js'
import { maskIban } from '../_shared/maskIban.js'
import { loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { validateEventPayout } from '../_shared/registration/eventPayout.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

const FIELD_LABELS = {
  payout_mode: 'Konto', payout_recipient: 'Odbiorca', payout_tax_id: 'NIP', payout_iban: 'Rachunek', payout_title: 'Tytuł przelewu',
}
const MODE_WORDS = { club: 'konto klubu', custom: 'inne konto' }

function shown(field, value) {
  if (field === 'payout_iban') return maskIban(value) ?? '—'
  if (field === 'payout_mode') return MODE_WORDS[value] ?? MODE_WORDS.club
  return value || '—'
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// POST { eventId, mode: 'club'|'custom', recipient?, taxId?, iban?, title? }
//   → 200 { data: { saved: true, changed } }.
// The payout account of one event: the club's own (club_payout_details) or
// another one, e.g. a charity's. Club owner only (spec §14.8): an admin or a
// member gets 403, an outsider or a disabled club 404. Applied at once, in a
// draft and after publish alike; it is not a wizard section and is never
// staged. save_event_payout writes the details and appends
// event_payout_history in one transaction. The owner is emailed, with the
// account masked; the audit row names the changed fields, never the values.
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
    if (role !== 'owner') return json({ error: 'Dane do wypłat zmienia właściciel klubu.' }, 403, req)

    const checked = validateEventPayout(body)
    if (!checked.ok) return json({ error: checked.error }, 400, req)

    const { data: saved, error } = await admin.rpc('save_event_payout', {
      p_event_id: settings.event_id, p_actor: session.userId, ...checked.value,
    })
    if (error) {
      if (error.message === 'forbidden') return json({ error: 'Dane do wypłat zmienia właściciel klubu.' }, 403, req)
      if (error.message === 'invalid_payout') return json({ error: 'Nieprawidłowe dane do wypłat.' }, 400, req)
      throw error
    }
    const prev = saved?.old ?? null
    const next = saved.new
    const changed = Object.keys(FIELD_LABELS).filter((f) => (prev?.[f] ?? (f === 'payout_mode' ? 'club' : null)) !== next[f])

    // Field names only: the audit table must never hold the values.
    await logOrganizerAction(admin, req, {
      actorId: session.userId, clubId: settings.club_id, eventId: settings.event_id,
      action: 'event_payout_changed', target: settings.event_id, payload: { fields: changed },
    })

    // Best effort: the rows above are the record, the email is a notice.
    try {
      const { data: club } = await admin.from('clubs').select('owner_id').eq('id', settings.club_id).maybeSingle()
      const { data: ownerProfile } = await admin.from('profiles').select('email')
        .eq('id', club?.owner_id || session.userId).maybeSingle()
      if (ownerProfile?.email) {
        const lines = changed.length === 0
          ? ['Dane zostały zapisane bez zmian.']
          : changed.map((f) => `${FIELD_LABELS[f]}: ${shown(f, prev?.[f])} → ${shown(f, next[f])}`)
        const text = [`Zmieniono dane do wypłat zawodów ${settings.name}.`, '', ...lines, '',
          'Jeśli to nie Ty, napisz do nas: kontakt@leszy.run.'].join('\n')
        await sendEmail({
          to: ownerProfile.email,
          subject: `Zmieniono dane do wypłat zawodów ${settings.name}`,
          text,
          html: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`,
        })
      }
    } catch (err) {
      console.error('update-event-payout: owner email failed:', err?.message)
    }

    return json({ data: { saved: true, changed } }, 200, req)
  } catch (err) {
    // Never the whole error: PostgREST details can echo the IBAN or NIP.
    console.error('update-event-payout error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
