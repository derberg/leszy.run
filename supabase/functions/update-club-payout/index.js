import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { clubRole, clubRegistrationEnabled, logOrganizerAction } from '../_shared/organizer.js'
import { sendEmail } from '../_shared/email.js'
import { maskIban } from '../_shared/maskIban.js'
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

function shown(field, value) {
  if (field === 'iban') return maskIban(value) ?? '—'
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

    // Owner only, and only once the club has online registration: a waitlisted
    // club gives no payout data. Role first, so a non-member cannot probe enablement.
    const role = await clubRole(admin, clubId, session.userId)
    if (!role) return json({ error: 'Brak uprawnień.' }, 403, req)
    if (role !== 'owner') return json({ error: 'Dane do wypłat zmienia właściciel klubu.' }, 403, req)
    if (!(await clubRegistrationEnabled(admin, clubId))) return json({ error: 'Not found' }, 404, req)

    const name = String(legalName ?? '').trim()
    const addr = String(address ?? '').trim()
    if (!name) return json({ error: 'Podaj nazwę podmiotu.' }, 400, req)
    if (!addr) return json({ error: 'Podaj adres.' }, 400, req)
    if (name.length > 200) return json({ error: 'Nazwa podmiotu jest za długa (maks. 200 znaków).' }, 400, req)
    if (addr.length > 300) return json({ error: 'Adres jest za długi (maks. 300 znaków).' }, 400, req)
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

    // One transaction: details row + history row (history is appended even when nothing changed).
    const { data: saved, error: saveErr } = await admin.rpc('save_club_payout', {
      p_club_id: clubId, p_actor: session.userId, p_club_name: club.name, p_new: next,
    })
    if (saveErr) throw saveErr
    const prev = saved?.old ?? null

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
    // Never the whole error: PostgREST details can echo the IBAN or NIP.
    console.error('update-club-payout error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
