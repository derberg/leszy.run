import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { checkAndIncrement } from '../_shared/throttle.js'
import { sendBulkEmail, sendEmail } from '../_shared/email.js'
import { isUuid, loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { allRows } from '../_shared/registration/allRows.js'
import { resolveAudience } from '../_shared/registration/audience.js'
import { clubSender } from '../_shared/registration/organizerSender.js'
import { releaseSlot, sendOnAllowance } from '../_shared/registration/organizerMail.js'

function json(body, status, req, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  })
}

const NOT_FOUND = { error: 'Not found' }
const MODES = ['preview', 'test', 'send']
const SUBJECT_MAX = 150
const BODY_MAX = 5000
const HOUR = 3600
const DAY = 86400
// Ruling 9: a bulk message 5 per event per 24 h, „Napisz do zawodnika” 30 per event per hour,
// a test 10 per sender per hour. All fail closed: each one sends mail.
const LIMITS = {
  bulk: (eventId) => ({ key: `message:${eventId}`, limit: 5, windowSeconds: DAY }),
  single: (eventId) => ({ key: `message-one:${eventId}`, limit: 30, windowSeconds: HOUR }),
  test: (actorId) => ({ key: `message-test:${actorId}`, limit: 10, windowSeconds: HOUR }),
}
const THROTTLED = 'Limit wiadomości wyczerpany. Spróbuj później.'
const TEST_FAILED = 'Nie udało się wysłać wiadomości próbnej. Spróbuj ponownie za chwilę.'

const REG_COLUMNS = 'id, status, category_id, email, order_id, team_id, profile_id, registered_by_profile_id, ' +
  'consent_state, guardian_email, guardian_name, guardian_profile_id, guardian_removed_at'

/** subject and body, trimmed and checked → { subject, body } | { fields } */
function checkMessage(input) {
  const fields = {}
  const subject = typeof input?.subject === 'string' ? input.subject.trim() : ''
  const text = typeof input?.body === 'string' ? input.body.trim() : ''
  if (!subject) fields.subject = 'Podaj temat wiadomości.'
  else if (/[\r\n]/.test(subject)) fields.subject = 'Temat musi się zmieścić w jednym wierszu.'
  else if (subject.length > SUBJECT_MAX) fields.subject = `Najwyżej ${SUBJECT_MAX} znaków.`
  if (!text) fields.body = 'Podaj treść wiadomości.'
  else if (text.length > BODY_MAX) fields.body = `Najwyżej ${BODY_MAX} znaków.`
  return Object.keys(fields).length ? { fields } : { subject, body: text }
}

/** The audience filter as resolveAudience takes it, or null for one it would refuse. */
function checkAudience(audience) {
  if (!audience || typeof audience !== 'object') return null
  const categoryIds = audience.categoryIds ?? []
  if (!Array.isArray(categoryIds) || categoryIds.some((id) => !isUuid(id))) return null
  if (!['confirmed', 'awaiting', 'all'].includes(audience.status)) return null
  if (!['members', 'captains'].includes(audience.teams)) return null
  return { categoryIds, status: audience.status, teams: audience.teams }
}

/**
 * The registrations resolveAudience reads: snake_case rows with `is_captain` from
 * teams.captain_registration_id and a pending row's order deadline as `expires_at`.
 */
async function audienceRows(admin, eventId, registrationId = null) {
  const regs = await allRows(() => {
    let q = admin.from('registrations').select(REG_COLUMNS).eq('event_id', eventId)
    if (registrationId) q = q.eq('id', registrationId)
    return q.order('id')
  })
  const [teams, orders] = await Promise.all([
    allRows(() => admin.from('teams').select('id, captain_registration_id').eq('event_id', eventId).order('id')),
    allRows(() => admin.from('orders').select('id, expires_at').eq('event_id', eventId).eq('status', 'pending').order('id')),
  ])
  const captains = new Set(teams.map((t) => t.captain_registration_id))
  const deadline = new Map(orders.map((o) => [o.id, o.expires_at]))
  return regs.map((r) => ({
    ...r,
    is_captain: captains.has(r.id),
    expires_at: r.status === 'pending_payment' ? (deadline.get(r.order_id) ?? null) : null,
  }))
}

async function claim(admin, { key, limit, windowSeconds }) {
  return checkAndIncrement(admin, key, limit, { windowSeconds })
}

const throttled = (req, retryAfterSec) =>
  json({ error: THROTTLED, code: 'throttled' }, 429, req, { 'Retry-After': String(retryAfterSec ?? 60) })

// POST { eventId, audience | registrationId, subject, body, mode } → the organizer writes to the
// event's participants as the club (B3a).
//   audience        { categoryIds?: [id], status: 'confirmed' | 'awaiting' | 'all',
//                   teams: 'members' | 'captains' }: resolveAudience, one e-mail per address,
//                   a child through the guardian, nothing for cancelled, expired or lapsed entries
//   registrationId  „Napisz do zawodnika”: that one entry, if it is still live
//   mode preview    → 200 { data: { count } }, no subject or body needed, nothing sent or counted
//   mode test       → 200 { data: { recipientCount: 1, failed: 0 } }, to the caller's own address
//                   only; 502 email_failed when it did not go out (a refusal or the 10 s timeout),
//                   and the test allowance is given back
//   mode send       → 200 { data: { recipientCount, failed } }; the organizer_messages row is written
//                   first with recipient_count 0 and its count after (a crash leaves a row saying 0,
//                   never mail with no record), as Plan 2's change notice does
// Plain text, from „<klub> przez LESZY.RUN”, reply-to the event's contact address, never anyone's
// own (P2-R19). 422 for a bad subject (a line break included: SendGrid refuses one after the
// slot is spent), body or audience, 409 no_recipients, 429 past ruling 9's
// limits. The owner or an admin of the event's club: a member 403, an outsider or a disabled club
// 404. No address reaches a log.
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
    const { mode, registrationId } = body ?? {}
    // „Napisz do zawodnika”: the event is the registration's, never the client's word for it.
    let eventId = body?.eventId
    if (registrationId !== undefined) {
      if (!isUuid(registrationId)) return json(NOT_FOUND, 404, req)
      const { data: reg, error } = await admin.from('registrations').select('event_id').eq('id', registrationId).maybeSingle()
      if (error) throw error
      if (!reg) return json(NOT_FOUND, 404, req)
      eventId = reg.event_id
    }
    const loaded = await loadOrganizerEvent(admin, eventId, session, { write: true, req })
    if (loaded instanceof Response) return loaded
    const { settings } = loaded
    if (!MODES.includes(mode)) return json({ error: 'Nieznany tryb wysyłki.', code: 'invalid_mode' }, 400, req)

    const single = registrationId !== undefined
    const audience = single ? { categoryIds: [], status: 'all', teams: 'members' } : checkAudience(body.audience)
    if (!audience) return json({ error: 'Wybierz odbiorców.', code: 'invalid_audience' }, 422, req)
    const recipients = resolveAudience(await audienceRows(admin, settings.event_id, single ? registrationId : null), audience)
    if (mode === 'preview') return json({ data: { count: recipients.length } }, 200, req)

    const message = checkMessage(body)
    if (message.fields) return json({ error: 'Popraw zaznaczone pola.', code: 'invalid_message', fields: message.fields }, 422, req)
    const sender = await clubSender(admin, settings)
    const audit = { actorId: session.userId, clubId: settings.club_id, eventId: settings.event_id }

    if (mode === 'test') {
      const limit = LIMITS.test(session.userId)
      const out = await sendOnAllowance({
        claim: () => claim(admin, limit),
        release: releaseSlot(admin, limit.key),
        send: () => sendEmail({ to: session.email, subject: message.subject, text: message.body, ...sender }),
      })
      if (out.throttled) return throttled(req, out.throttled)
      if (out.failed) return json({ error: TEST_FAILED, code: 'email_failed' }, 502, req)
      await logOrganizerAction(admin, req, { ...audit, action: 'message_test_sent', target: settings.event_id, payload: { failed: 0 } })
      return json({ data: { recipientCount: 1, failed: 0 } }, 200, req)
    }

    if (!recipients.length) return json({ error: 'Nikt z wybranych osób nie dostanie tej wiadomości.', code: 'no_recipients' }, 409, req)
    const t = await claim(admin, single ? LIMITS.single(settings.event_id) : LIMITS.bulk(settings.event_id))
    if (!t.allowed) return throttled(req, t.retryAfterSec)

    const filter = single ? { kind: 'single', registrationId } : { kind: 'organizer_message', ...audience }
    const { data: row, error: insErr } = await admin.from('organizer_messages').insert({
      event_id: settings.event_id, sent_by: session.userId, subject: message.subject, body: message.body,
      filter, recipient_count: 0,
    }).select('id').single()
    if (insErr) throw insErr
    const { sent, failed } = await sendBulkEmail(recipients.map((r) => r.email), {
      subject: message.subject, text: message.body, ...sender,
    })
    const { error: uErr } = await admin.from('organizer_messages').update({ recipient_count: sent }).eq('id', row.id)
    if (uErr) console.error('organizer_messages count update failed:', uErr.message)
    await logOrganizerAction(admin, req, {
      ...audit, action: 'message_sent', target: row.id, payload: { recipientCount: sent, failed, ...filter },
    })
    return json({ data: { recipientCount: sent, failed } }, 200, req)
  } catch (err) {
    console.error('send-organizer-message error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
