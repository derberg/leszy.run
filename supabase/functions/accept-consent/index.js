// POST { token, acceptedConsentIds, serviceRegulamin, edits? } — the added adult accepts the
// regulamin (Plan 4). Needs a session whose address is the registration's (consent-request's
// code opens one); the payer's session is not enough. consent-token:<hash> 10/h, shared with
// consent-request.
//
// edits (ruling 6): firstName, lastName, phone, city, club, iceName, icePhone, nationality,
// birthDate, gender. Only values that differ from the entry count, so a form sending its
// unchanged fields back is not an edit. The e-mail is never editable. validatePerson words the
// field errors here; accept_consent_request re-checks everything under its locks.
//
// → 200 { data: { status: 'accepted', registrationId, event: { name, slug } } }
//   400 consents_required (a box missing) | consents_changed (the event's consents changed)
//       „Zaznacz wymagane zgody.”
//   403 session_required (no session, or another address), profile_mismatch
//   409 gone „To zgłoszenie nie jest już aktywne.”
//   410 invalid | expired „Ten link został już użyty albo wygasł.”
//   422 edits_closed „Po zamknięciu zapisów dane poprawisz w biurze zawodów.” (closes_at passed)
//   422 edit_invalid { fields: { [field]: message } }
//   429 throttled
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { clientIp } from '../_shared/organizer.js'
import { json } from '../_shared/registration/registrationRequest.js'
import { validatePerson } from '../_shared/registration/person.js'
import {
  EDITS_CLOSED, GONE_ENTRY, GONE_LINK, loadByToken, personContext, personOf, sessionMatches, throttled, tokenHash,
  WRONG_SESSION,
} from '../_shared/registration/consentAccess.js'

const TOKEN_LIMIT = 10
const EDITABLE = ['firstName', 'lastName', 'phone', 'city', 'club', 'iceName', 'icePhone', 'nationality', 'birthDate', 'gender']
const CONSENTS = 'Zaznacz wymagane zgody.'
const INVALID = 'Popraw zaznaczone pola.'

const norm = (key, v) => {
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null
  return key === 'nationality' ? s.toUpperCase() : s
}
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x))

const RPC_ERRORS = {
  gone: [409, GONE_ENTRY],
  profile_mismatch: [403, WRONG_SESSION],
  consents_changed: [400, CONSENTS],
  edits_closed: [422, EDITS_CLOSED],
  edit_invalid: [422, INVALID],
}

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  let registrationId = null
  try {
    const hash = await tokenHash(body?.token)
    const limited = await throttled(admin, req, [{ key: `consent-token:${hash}`, limit: TOKEN_LIMIT }])
    if (limited) return limited

    const found = await loadByToken(admin, req, body?.token, hash, { strict: false })
    if (found.response) return found.response
    const { registration } = found
    registrationId = registration.id

    const session = await getSession(req, admin)
    if (!sessionMatches(session, registration)) {
      return json({ error: WRONG_SESSION, code: 'session_required' }, 403, req)
    }

    // ---- the boxes: every event consent (image included) and the LESZY.RUN service regulamin
    const { data: consents, error: cErr } = await admin.from('event_consents').select('id').eq('event_id', registration.event_id)
    if (cErr) throw cErr
    const consentIds = (consents ?? []).map((c) => c.id)
    const { acceptedConsentIds, serviceRegulamin } = body ?? {}
    if (serviceRegulamin !== true || !Array.isArray(acceptedConsentIds) || !sameSet(acceptedConsentIds, consentIds)) {
      return json({ error: CONSENTS, code: 'consents_required' }, 400, req)
    }

    // ---- the edits: only changed values, never the address
    const edits = body?.edits ?? null
    if (edits !== null && (typeof edits !== 'object' || Array.isArray(edits))) {
      return json({ error: INVALID, code: 'edit_invalid', fields: {} }, 422, req)
    }
    const current = personOf(registration)
    const changed = {}
    const fields = {}
    for (const [key, value] of Object.entries(edits ?? {})) {
      if (key === 'email') {
        if (norm(key, value)?.toLowerCase() !== norm(key, current.email)?.toLowerCase()) fields.email = 'Adresu e-mail nie można zmienić.'
        continue
      }
      if (!EDITABLE.includes(key)) { fields[key] = 'Tego pola nie można zmienić.'; continue }
      if (value !== null && typeof value !== 'string') { fields[key] = 'Nieprawidłowa wartość.'; continue }
      if (norm(key, value) !== norm(key, current[key])) changed[key] = norm(key, value)
    }
    if (Object.keys(fields).length) return json({ error: INVALID, code: 'edit_invalid', fields }, 422, req)

    const { settings, ctx } = await personContext(admin, registration)
    const hasEdits = Object.keys(changed).length > 0
    // §14.3: nothing is editable once registration has closed (the acceptance itself still is).
    if (hasEdits && !(Date.now() < Date.parse(settings.closes_at))) {
      return json({ error: EDITS_CLOSED, code: 'edits_closed' }, 422, req)
    }
    if (hasEdits) {
      const checked = validatePerson({ ...current, ...changed }, ctx)
      if (!checked.ok) return json({ error: INVALID, code: 'edit_invalid', fields: checked.errors }, 422, req)
      if (checked.value.isMinor) {
        return json({
          error: INVALID, code: 'edit_invalid',
          fields: { birthDate: 'Z tą datą urodzenia osoba byłaby niepełnoletnia. Zapisuje ją rodzic lub opiekun.' },
        }, 422, req)
      }
    }

    const { data: outcome, error } = await admin.rpc('accept_consent_request', {
      p_token_hash: hash,
      p_profile_id: session.userId,
      p_edits: hasEdits ? changed : null,
      p_meta: { consentIds, ip: clientIp(req), userAgent: req.headers.get('user-agent') || null },
    })
    if (error) {
      const known = RPC_ERRORS[error.message]
      if (!known) throw error
      const [status, text] = known
      return json({ error: text, code: error.message, ...(error.message === 'edit_invalid' ? { fields: {} } : {}) }, status, req)
    }
    if (outcome?.status !== 'accepted') {
      return json({ error: GONE_LINK, code: outcome?.status === 'expired' ? 'expired' : 'invalid' }, 410, req)
    }
    return json({
      data: { status: 'accepted', registrationId: outcome.registrationId, event: { name: settings.name, slug: settings.slug } },
    }, 200, req)
  } catch (err) {
    console.error('accept-consent error:', registrationId ? `registration ${registrationId}:` : '', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
