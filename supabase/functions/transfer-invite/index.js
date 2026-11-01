// POST { action, … } — the holder's side of a package transfer (Plan 7, RA6). A session is
// required (401); the entry must be the session's own, so a stranger, whoever they are, gets 404.
//
//   create { registrationId, toEmail } → 201 { data: { transferId, expiresAt, toEmail, emailed } }
//       A fresh token, create_transfer (only its SHA-256 is stored), then the invite e-mail to
//       toEmail with the link `${PUBLIC_SITE_URL}/przekazanie#<token>`: the token travels in the
//       fragment only (Plan 4's rule), so it never reaches a server log, a referrer or an answer.
//       transfer-create:<registrationId>, 5 per 24 h, claimed before the RPC (fail closed: this
//       path mails an address the caller names).
//   cancel { transferId }              → 200 { data: { cancelled: true } }
//       cancel_transfer, then „Zaproszenie cofnięte” to the invited address. 409 not_pending when
//       the invite was accepted, cancelled or expired meanwhile (no e-mail).
//   status { registrationId }          → 200 { data: { allowed, until, pending } }
//       The transfer block my-event-registrations carries, for one entry.
//
// Refusals: TRANSFER_REFUSALS (not_owner / not_found 404, not_transferable, transfer_off,
// same_person, pending_exists 409, invalid_email 400), 429 throttled. Every e-mail is claimed on the
// transfer row before it goes out (at most once) and only after the RPC returned without error.
// Logs name transfers and registrations by id, never an address or a token.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { checkAndIncrement } from '../_shared/throttle.js'
import { json } from '../_shared/registration/registrationRequest.js'
import { isUuid } from '../_shared/registration/organizerEvent.js'
import { newToken } from '../_shared/registration/tokens.js'
import { publicSite } from '../_shared/registration/consentRequests.js'
import { transferCancelledEmail, transferInviteEmail } from '../_shared/registration/transferEmails.js'
import { sendTransferEmail, TRANSFER_REFUSALS, transferViews } from '../_shared/registration/transfers.js'

const NOT_FOUND = { error: 'Not found' }
const TOO_MANY = 'Zbyt wiele zaproszeń. Spróbuj ponownie jutro.'
const NOT_PENDING = 'Zaproszenia nie można już cofnąć: zostało przyjęte, cofnięte albo wygasło.'
const CREATE_LIMIT = 5
const DAY = 86400
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const REG_COLUMNS = 'id, event_id, category_id, first_name, status, email, birth_date, profile_id, guardian_profile_id, team_id'

/** An RPC refusal as its answer; anything unknown is thrown (a 500). */
function refusalOrThrow(req, error) {
  const known = TRANSFER_REFUSALS[error?.message]
  if (!known) throw error
  const [status, text] = known
  return json({ error: text, code: error.message }, status, req)
}

async function single(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

/** The session's own entry, or null (unknown, malformed, or anybody else's: all 404). */
async function ownEntry(admin, registrationId, userId) {
  if (!isUuid(registrationId)) return null
  const reg = await single(admin.from('registrations').select(REG_COLUMNS).eq('id', registrationId).maybeSingle())
  return reg && reg.profile_id === userId ? reg : null
}

async function eventOf(admin, reg) {
  const [settings, competition] = await Promise.all([
    single(admin.from('registration_settings')
      .select('event_id, name, slug, event_date, first_start_time, town_label, place_details, transfer_enabled, transfer_until')
      .eq('event_id', reg.event_id).single()),
    single(admin.from('competitions').select('name, start_time').eq('category_id', reg.category_id).maybeSingle()),
  ])
  return { settings, competition }
}

const eventFacts = (settings) => ({
  name: settings.name,
  eventDate: settings.event_date,
  place: [settings.town_label, settings.place_details].filter(Boolean).join(', ') || null,
})

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  const session = await getSession(req, admin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  let ref = null
  try {
    const action = body?.action

    if (action === 'status') {
      const reg = await ownEntry(admin, body.registrationId, session.userId)
      if (!reg) return json(NOT_FOUND, 404, req)
      ref = `registration ${reg.id}`
      const { settings } = await eventOf(admin, reg)
      const views = await transferViews(admin, [reg], settings, session.userId)
      return json({ data: views.get(reg.id) }, 200, req)
    }

    if (action === 'create') {
      const reg = await ownEntry(admin, body.registrationId, session.userId)
      if (!reg) return json(NOT_FOUND, 404, req)
      ref = `registration ${reg.id}`
      const toEmail = typeof body.toEmail === 'string' ? body.toEmail.trim().toLowerCase() : ''
      if (!EMAIL_RE.test(toEmail) || toEmail.length > 254) {
        return json({ error: TRANSFER_REFUSALS.invalid_email[1], code: 'invalid_email' }, 400, req)
      }
      const throttle = await checkAndIncrement(admin, `transfer-create:${reg.id}`, CREATE_LIMIT, { windowSeconds: DAY })
      if (!throttle.allowed) {
        return json({ error: TOO_MANY, code: 'throttled' }, 429, req, { 'retry-after': String(throttle.retryAfterSec) })
      }

      const { token, hash } = await newToken()
      const { data, error } = await admin.rpc('create_transfer', {
        p_registration_id: reg.id, p_actor: session.userId, p_to_email: toEmail, p_token_hash: hash,
      })
      if (error) return refusalOrThrow(req, error)

      const { settings, competition } = await eventOf(admin, reg)
      const mail = transferInviteEmail({
        event: eventFacts(settings),
        senderFirstName: reg.first_name,
        competition: { name: competition?.name ?? null, startTime: (competition?.start_time ?? settings.first_start_time)?.slice(0, 5) ?? null },
        link: `${publicSite()}/przekazanie#${token}`,
        until: settings.transfer_until,
      })
      const emailed = await sendTransferEmail(admin, data.transferId, 'invite_emailed_at', toEmail, mail)
      return json({ data: { transferId: data.transferId, expiresAt: data.expiresAt, toEmail, emailed } }, 201, req)
    }

    if (action === 'cancel') {
      if (!isUuid(body.transferId)) return json(NOT_FOUND, 404, req)
      ref = `transfer ${body.transferId}`
      const { data: cancelled, error } = await admin.rpc('cancel_transfer', { p_transfer_id: body.transferId, p_actor: session.userId })
      if (error) return refusalOrThrow(req, error)
      if (cancelled !== true) return json({ error: NOT_PENDING, code: 'not_pending' }, 409, req)

      const t = await single(admin.from('transfers').select('id, registration_id, to_email').eq('id', body.transferId).single())
      const reg = await single(admin.from('registrations').select(REG_COLUMNS).eq('id', t.registration_id).single())
      const { settings } = await eventOf(admin, reg)
      await sendTransferEmail(admin, t.id, 'cancel_emailed_at', t.to_email,
        transferCancelledEmail({ event: eventFacts(settings), senderFirstName: reg.first_name }))
      return json({ data: { cancelled: true } }, 200, req)
    }

    return json({ error: 'Nieznana operacja.', code: 'invalid_action' }, 400, req)
  } catch (err) {
    console.error('transfer-invite error:', ref ?? '', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
