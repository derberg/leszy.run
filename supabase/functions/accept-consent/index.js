// POST { token, acceptedConsentIds, shownConsentIds?, serviceRegulamin, edits? } — the added
// adult accepts the regulamin (Plan 4). Needs a session whose address is the registration's
// (consent-request's code opens one); the payer's session is not enough. consent-ip:<ip> 30/h and
// consent-token:<hash> 30/h, both shared with consent-request.
//
// The boxes (review I1): acceptedConsentIds are the ticked ones, shownConsentIds the ones the page
// displayed (optional; without it the ticked set stands for it). A shown set that is not the
// event's current set means the page went stale (an organizer published a consent meanwhile):
// consents_changed, and the page re-reads consent-request. A ticked set short of the shown one is
// a box left unticked: consents_required. The client's ticked ids go to accept_consent_request,
// which compares them with the set it reads under the settings lock, so a publish that lands
// after this check still answers consents_changed.
//
// edits (ruling 6): firstName, lastName, phone, city, club, iceName, icePhone, nationality,
// birthDate, gender. Only values that differ from the entry count, so a form sending its
// unchanged fields back is not an edit, and only those values are validated (review m2): a field
// the organizer made required after this person registered does not block another correction.
// A value for a field the event switched off is refused by name. The e-mail is never editable.
// validatePerson words the field errors here; accept_consent_request re-checks everything under
// its locks.
//
// → 200 { data: { status: 'accepted', registrationId, event: { name, slug } } }
//   400 consents_required (no ticked list, a box left unticked, or serviceRegulamin not true)
//       | consents_changed (the event's consents are not the ones the page showed)
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
import { clientIp } from '../_shared/clientIp.js'
import { json } from '../_shared/registration/registrationRequest.js'
import { ADULT_AGE, validatePerson } from '../_shared/registration/person.js'
import { ageOn } from '../_shared/registration/ageGroups.js'
import { warsawToday } from '../_shared/registration/dates.js'
import {
  EDITS_CLOSED, GONE_ENTRY, GONE_LINK, IP_LIMIT, ipKey, loadByToken, personContext, personOf, sessionMatches, throttled,
  TOKEN_LIMIT, tokenHash, WRONG_SESSION,
} from '../_shared/registration/consentAccess.js'

const EDITABLE = ['firstName', 'lastName', 'phone', 'city', 'club', 'iceName', 'icePhone', 'nationality', 'birthDate', 'gender']
const CONSENTS = 'Zaznacz wymagane zgody.'
const INVALID = 'Popraw zaznaczone pola.'
const SWITCHED_OFF = 'Tego pola nie zbieramy na tych zawodach.'
const MINOR = 'Z tą datą urodzenia osoba byłaby niepełnoletnia. Zapisuje ją rodzic lub opiekun.'
// The form_fields switch behind each editable field, and its mode when the event stored none.
const SWITCH = { city: ['city', 'optional'], club: ['club', 'optional'], iceName: ['ice', 'optional'],
  icePhone: ['ice', 'optional'], nationality: ['nationality', 'off'] }
// One switch, two inputs: a change to either is judged with the other (the RPC checks the pair).
const PAIRED = { iceName: 'icePhone', icePhone: 'iceName' }

const norm = (key, v) => {
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null
  return key === 'nationality' ? s.toUpperCase() : s
}
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x))
const idList = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')

const RPC_ERRORS = {
  gone: [409, GONE_ENTRY],
  profile_mismatch: [403, WRONG_SESSION],
  consents_changed: [400, CONSENTS],
  edits_closed: [422, EDITS_CLOSED],
  edit_invalid: [422, INVALID],
}

/**
 * The field errors of the changed values only (review m2) → { [field]: message }. A value for a
 * switched-off field is named here (validatePerson would silently drop it and the RPC refuse it
 * with no field). The rest is validatePerson on the edited person, keeping only the errors of the
 * changed fields, plus the adult check for a changed birth date.
 */
function editErrors(current, changed, ctx) {
  const touched = new Set(Object.keys(changed))
  for (const [a, b] of Object.entries(PAIRED)) if (touched.has(a)) touched.add(b)
  const errors = {}
  for (const key of Object.keys(changed)) {
    const sw = SWITCH[key]
    if (sw && changed[key] != null && (ctx.formFields?.[sw[0]] ?? sw[1]) === 'off') errors[key] = SWITCHED_OFF
  }
  const checked = validatePerson({ ...current, ...changed }, ctx)
  for (const [key, message] of Object.entries(checked.errors ?? {})) {
    if (touched.has(key) && !errors[key]) errors[key] = message
  }
  if ('birthDate' in changed && !errors.birthDate && changed.birthDate
      && ageOn(changed.birthDate, warsawToday(), 'race_day') < ADULT_AGE) {
    errors.birthDate = MINOR
  }
  return errors
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
    // consent-ip:<ip> is consent-request's counter too (final review M-5): one per-IP budget for the page.
    const ipThrottle = ipKey(req)
    const limited = await throttled(admin, req, [
      ...(ipThrottle ? [{ key: ipThrottle, limit: IP_LIMIT }] : []),
      { key: `consent-token:${hash}`, limit: TOKEN_LIMIT },
    ])
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
    const { acceptedConsentIds, shownConsentIds, serviceRegulamin } = body ?? {}
    if (serviceRegulamin !== true || !idList(acceptedConsentIds)) {
      return json({ error: CONSENTS, code: 'consents_required' }, 400, req)
    }
    const shown = idList(shownConsentIds) ? shownConsentIds : acceptedConsentIds
    if (!sameSet(shown, consentIds)) return json({ error: CONSENTS, code: 'consents_changed' }, 400, req)
    if (!sameSet(acceptedConsentIds, shown)) return json({ error: CONSENTS, code: 'consents_required' }, 400, req)

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
      const errors = editErrors(current, changed, ctx)
      if (Object.keys(errors).length) return json({ error: INVALID, code: 'edit_invalid', fields: errors }, 422, req)
    }

    const { data: outcome, error } = await admin.rpc('accept_consent_request', {
      p_token_hash: hash,
      p_profile_id: session.userId,
      p_edits: hasEdits ? changed : null,
      p_meta: { consentIds: acceptedConsentIds, ip: clientIp(req), userAgent: req.headers.get('user-agent') || null },
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
