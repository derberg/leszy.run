import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { clubRole, logOrganizerAction } from '../_shared/organizer.js'
import { sendEmail } from '../_shared/email.js'
import {
  normalizeIban, normalizeNip, isValidPolishIban, isValidNip, isValidKrs,
} from '../_shared/payoutValidation.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

const FIELD_LABELS = { legal_name: 'Nazwa', nip: 'NIP', krs: 'KRS', iban: 'Rachunek', address: 'Adres' }

/** PL61109010140000071219812874 -> "PL61 … 2874" (first 4 + last 4). */
function maskIban(iban) {
  return iban ? `${iban.slice(0, 4)} … ${iban.slice(-4)}` : '—'
}

function shown(field, value) {
  if (field === 'iban') return maskIban(value)
  return value || '—'
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const session = await getSession(req, admin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try {
    const { clubId, legalName, nip, krs, iban, address } = await req.json()
    if (!clubId) return json({ error: 'clubId required' }, 400, req)

    // Owner only. Payout details may be entered while the club is still on the waitlist.
    const role = await clubRole(admin, clubId, session.userId)
    if (!role) return json({ error: 'Brak uprawnień.' }, 403, req)
    if (role !== 'owner') return json({ error: 'Dane do wypłat zmienia właściciel klubu.' }, 403, req)

    const name = String(legalName ?? '').trim()
    const addr = String(address ?? '').trim()
    if (!name) return json({ error: 'Podaj nazwę podmiotu.' }, 400, req)
    if (!addr) return json({ error: 'Podaj adres.' }, 400, req)
    if (!isValidNip(nip)) return json({ error: 'Nieprawidłowy NIP.' }, 400, req)
    if (!isValidKrs(krs)) return json({ error: 'Nieprawidłowy KRS.' }, 400, req)
    if (!isValidPolishIban(iban)) return json({ error: 'Nieprawidłowy numer rachunku.' }, 400, req)

    const next = {
      legal_name: name,
      nip: normalizeNip(nip),
      krs: krs && String(krs).trim() ? String(krs).trim() : null,
      iban: normalizeIban(iban),
      address: addr,
    }

    const { data: club } = await admin.from('clubs').select('name, owner_id').eq('id', clubId).maybeSingle()
    if (!club) return json({ error: 'Not found' }, 404, req)

    const { data: prev } = await admin.from('club_payout_details')
      .select('legal_name, nip, krs, iban, address').eq('club_id', clubId).maybeSingle()

    const { error: upErr } = await admin.from('club_payout_details').upsert({
      club_id: clubId, ...next, updated_by: session.userId, updated_at: new Date().toISOString(),
    })
    if (upErr) throw upErr

    // History is appended even when nothing changed: it records who confirmed what and when.
    const { error: histErr } = await admin.from('club_payout_history').insert({
      club_id: clubId, club_name: club.name, changed_by: session.userId, old: prev ?? null, new: next,
    })
    if (histErr) throw histErr

    const changed = Object.keys(next).filter((f) => (prev?.[f] ?? null) !== next[f])
    // Field names only: the audit table must never hold the values.
    await logOrganizerAction(admin, req, {
      actorId: session.userId, clubId, action: 'payout_changed', payload: { fields: changed },
    })

    // Best effort: the rows above are the record, the email is a notice.
    try {
      const { data: ownerProfile } = await admin.from('profiles').select('email')
        .eq('id', club.owner_id || session.userId).maybeSingle()
      if (ownerProfile?.email) {
        const lines = changed.length === 0
          ? ['Dane zostały zapisane bez zmian.']
          : changed.map((f) => `${FIELD_LABELS[f]}: ${shown(f, prev?.[f])} → ${shown(f, next[f])}`)
        const text = [`Zmieniono dane do wypłat klubu ${club.name}.`, '', ...lines, '',
          'Jeśli to nie Ty, napisz do nas: kontakt@leszy.run.'].join('\n')
        await sendEmail({
          to: ownerProfile.email,
          subject: `Zmieniono dane do wypłat klubu ${club.name}`,
          text,
          html: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`,
        })
      }
    } catch (err) {
      console.error('update-club-payout: owner email failed:', err)
    }

    return json({ data: { saved: true, changed } }, 200, req)
  } catch (err) {
    console.error('update-club-payout error:', err)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
