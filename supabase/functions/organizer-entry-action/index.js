import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { checkAndIncrement } from '../_shared/throttle.js'
import { sendEmail } from '../_shared/email.js'
import { isUuid, loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { loadOrderView, orderEmailArgs } from '../_shared/registration/orderFlow.js'
import { paymentReminderEmail } from '../_shared/registration/emails.js'
import { issueConsentRequests, publicSite } from '../_shared/registration/consentRequests.js'
import { validatePerson } from '../_shared/registration/person.js'
import { personContexts } from '../_shared/registration/registrationRequest.js'
import { TEAM_NAME_MESSAGE } from '../_shared/registration/team.js'
import { releaseSlot, sendOnAllowance } from '../_shared/registration/organizerMail.js'
import { callTransferRpc, sendAcceptedTransferEmail, TRANSFER_REFUSALS } from '../_shared/registration/transfers.js'

function json(body, status, req, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  })
}

const NOT_FOUND = { error: 'Not found' }
const DAY = 86400
// Online payment stops an hour before closes_at (spec 14.10, create_order's paying_closed).
const PAYING_CLOSES_BEFORE_MS = 3600_000
const FIELD_MESSAGE = 'Sprawdź to pole.'
const ACTIONS = ['extend', 'remind_payment', 'cancel', 'edit', 'rename_team', 'partner', 'transfer']
// The fields „Edytuj dane” may change (ruling 7). Never the e-mail: the one-start key and the account.
const EDITABLE = ['firstName', 'lastName', 'birthDate', 'gender', 'phone', 'city', 'club', 'nationality', 'iceName', 'icePhone']

// Every refusal of the RPCs this function calls, by the message they raise.
const REFUSALS = {
  expired: [409, 'Zgłoszenie wygasło.'],
  invalid_until: [422, 'Termin wpłaty nie może przekroczyć zamknięcia zapisów.'],
  paid: [409, 'To zgłoszenie jest już opłacone.'],
  cancelled: [409, 'To zgłoszenie jest anulowane.'],
  full: [409, 'Brak wolnych miejsc w tej konkurencji.'],
  paying_closed: [409, 'Płatność online jest już zamknięta: kończy się godzinę przed zamknięciem zapisów.'],
  no_address: [409, 'Zamawiający nie ma już adresu e-mail.'],
  already_cancelled: [409, 'To zgłoszenie jest już anulowane.'],
  transferred: [409, 'Pakiet został przekazany innej osobie.'],
  not_live: [409, 'To zgłoszenie nie jest już aktywne.'],
  payment_received: [409, 'Płatność za to zgłoszenie jest w toku. Spróbuj za kilka minut.'],
  below_team_min: [409, 'Drużyna miałaby za mało osób. Anuluj kapitana, żeby anulować całą drużynę.'],
  edits_closed: [409, 'Po zamknięciu zapisów dane zmienia się w panelu pomiaru.'],
  ineligible: [422, 'Ta osoba nie spełnia wymagań wiekowych konkurencji.'],
  role_change: [409, 'Data urodzenia zmieniłaby zgłoszenie dziecka na zgłoszenie dorosłego albo odwrotnie.'],
  duplicate: [409, 'Ta osoba jest już zapisana na te zawody.'],
  edit_invalid: [422, 'Popraw zaznaczone pola.'],
  invalid_field: [422, 'Popraw zaznaczone pola.'],
  invalid_team_name: [422, TEAM_NAME_MESSAGE],
  team_name_taken: [409, 'Ta nazwa drużyny jest już zajęta.'],
  team_inactive: [409, 'To zgłoszenie nie jest już aktywne.'],
  invalid_partner: [422, 'Nieznany partner.'],
  not_found: [404, NOT_FOUND.error],
}

// organizer_transfer's refusals (Plan 7, ruling 4), worded for the organizer where the runner's copy
// would say „you”. The rest come from the shared table.
const ORGANIZER_TRANSFER_REFUSALS = {
  ...Object.fromEntries(Object.entries(TRANSFER_REFUSALS).map(([k, [status, text]]) => [k, [status === 400 ? 422 : status, text]])),
  gone: [409, 'To zgłoszenie nie jest już aktywne.'],
  duplicate: [409, 'Ta osoba jest już zapisana na te zawody.'],
  pending_elsewhere: [409, 'Ta osoba ma nieopłacone zgłoszenie na te zawody razem z innymi osobami.'],
  same_person: [409, 'To jest osoba, która ma ten pakiet.'],
  recipient_minor: [409, 'Pakiet może przejąć tylko osoba pełnoletnia.'],
  invalid_person: [422, 'Popraw zaznaczone pola.'],
}

/** A refusal by code. Every 422 carries `fields` (field → message), so the dialog marks the field. */
const refuse = (req, code, fields = undefined) => {
  const [status, error] = REFUSALS[code]
  return json(fields ? { error, code, fields } : { error, code }, status, req)
}

/**
 * An RPC error mapped to its 4xx answer; anything unexpected is thrown (a 500). `fieldsFor(code)`
 * names the fields of a 422: the SQL raises a code, never a field, so an edit marks every field it
 * touched (review M5).
 */
function refusalOrThrow(req, error, fieldsFor = () => undefined) {
  const msg = error?.message ?? ''
  if (REFUSALS[msg]) return refuse(req, msg, REFUSALS[msg][0] === 422 ? fieldsFor(msg) : undefined)
  throw error
}

async function single(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

/** The event a request's target belongs to, derived on the server (unknown → null). */
async function targetOf(admin, action, body) {
  if (action === 'rename_team') {
    if (!isUuid(body.teamId)) return null
    const team = await single(admin.from('teams').select('id, event_id').eq('id', body.teamId).maybeSingle())
    return team && { eventId: team.event_id, teamId: team.id }
  }
  if (action === 'extend' || action === 'remind_payment') {
    let orderId = body.orderId
    if (!isUuid(orderId) && isUuid(body.registrationId)) {
      const reg = await single(admin.from('registrations').select('order_id').eq('id', body.registrationId).maybeSingle())
      orderId = reg?.order_id
    }
    if (!isUuid(orderId)) return null
    const order = await single(admin.from('orders').select('id, event_id').eq('id', orderId).maybeSingle())
    return order && { eventId: order.event_id, orderId: order.id }
  }
  if (!isUuid(body.registrationId)) return null
  const reg = await single(admin.from('registrations').select('id, event_id').eq('id', body.registrationId).maybeSingle())
  return reg && { eventId: reg.event_id, registrationId: reg.id }
}

// „Przypomnij o wpłacie”: Plan 3's reminder e-mail, now. Refused for an order nobody can pay any more
// (D6-27, as pay-order refuses it), once online payment has stopped an hour before closes_at (review
// M2), and once per order per 24 h (`pay-remind:<orderId>`). Only a sent e-mail spends that
// allowance: a refused or timed-out send gives the slot back and answers { failed } (review M1).
async function remindPayment(admin, settings, orderId) {
  const order = await single(admin.from('orders').select('id, status, expires_at').eq('id', orderId).single())
  if (order.status === 'paid') return { refused: 'paid' }
  if (order.status === 'cancelled') return { refused: 'cancelled' }
  if (order.status !== 'pending' || (order.expires_at && Date.parse(order.expires_at) <= Date.now())) return { refused: 'expired' }
  if (!settings.closes_at || Date.now() >= Date.parse(settings.closes_at) - PAYING_CLOSES_BEFORE_MS) return { refused: 'paying_closed' }
  const { data: fits, error } = await admin.rpc('registration_order_fits', { p_order_id: orderId })
  if (error) throw error
  if (fits === false) return { refused: 'full' }
  const view = await loadOrderView(admin, orderId)
  if (!view?.order.buyer_email) return { refused: 'no_address' }
  const args = orderEmailArgs(view)
  const mail = paymentReminderEmail({ event: args.event, order: args.order, payUrl: `${publicSite()}/zamowienie/${encodeURIComponent(orderId)}` })
  const key = `pay-remind:${orderId}`
  return sendOnAllowance({
    claim: () => checkAndIncrement(admin, key, 1, { windowSeconds: DAY }),
    release: releaseSlot(admin, key),
    send: () => sendEmail({ to: view.order.buyer_email, ...mail }),
  })
}

/**
 * „Edytuj dane”: validatePerson over the stored person with the edits applied, so the organizer
 * gets the form's own messages, keyed by field. Only the fields the edit touches can fail: a value
 * stored before a form switch changed stays valid, as organizer_edit_registration also decides.
 * The age group and kids' group are re-derived by organizer_edit_registration itself under its
 * locks; a label computed here is never trusted (Task 2, decision 9).
 */
async function checkEdit(admin, settings, registrationId, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { invalid: {} }
  const keys = Object.keys(fields)
  if (!keys.length || keys.some((k) => !EDITABLE.includes(k) || (fields[k] !== null && typeof fields[k] !== 'string'))) {
    return { invalid: {} }
  }
  const reg = await single(admin.from('registrations')
    .select('category_id, first_name, last_name, birth_date, gender, email, phone, city, club, nationality, ice_name, ice_phone')
    .eq('id', registrationId).single())
  const competition = await single(admin.from('competitions').select('*').eq('category_id', reg.category_id).single())
  const context = (await personContexts(admin, settings, [competition])).get(competition.category_id)
  const stored = {
    firstName: reg.first_name, lastName: reg.last_name, birthDate: reg.birth_date, gender: reg.gender,
    email: reg.email, phone: reg.phone, city: reg.city, club: reg.club, nationality: reg.nationality,
    iceName: reg.ice_name, icePhone: reg.ice_phone,
  }
  const checked = validatePerson({ ...stored, ...fields }, { ...context, now: new Date() })
  const errors = Object.fromEntries(Object.entries(checked.errors).filter(([k]) => keys.includes(k)))
  return Object.keys(errors).length ? { invalid: errors } : { keys }
}

// POST { action, registrationId | orderId | teamId, … } → the organizer's actions on one entry that
// move no money (B3). The event comes from the target row, never from the client.
//   extend          { orderId | registrationId, until }  → 200 { data: { expiresAt } }
//                   „Przedłuż termin wpłaty”: up to 14 days and never past closes_at (ruling 2). It
//                   reserves no place (D6-13). 409 expired, 422 invalid_until.
//   remind_payment  { orderId | registrationId }          → 200 { data: { sent: true } }
//                   409 paid / cancelled / expired, 409 paying_closed (from an hour before
//                   closes_at), 409 full (D6-27), 409 no_address, 429 a second within 24 h,
//                   502 email_failed when the e-mail did not go out (no allowance spent).
//   cancel          { registrationId }                    → 200 { data: { cancelled, hostWithdraw } }
//                   cancel_registration: a pending entry cancels its whole order (D6-24, no refund),
//                   a captain the whole team, a confirmed entry is cancelled without a refund.
//   edit            { registrationId, fields }            → 200 { data: { changed, ageGroupLabel } }
//                   422 invalid_person, edit_invalid, invalid_field or ineligible, each with
//                   `fields`; 409 edits_closed after closes_at.
//   rename_team     { teamId, name }                      → 200 { data: { name } }
//                   409 team_name_taken, 422 invalid_team_name.
//   partner         { registrationId, partnerId | null } → 200 { data: { partnerId, changed } }
//                   B3 „Partner”: attributes a live entry to one of the event's partners, or clears
//                   it (Plan 7). 409 not_live, 422 invalid_partner (unknown or another event's).
//   transfer        { registrationId, person, categoryId } → 200 { data: { registrationId,
//                   consentState: 'awaiting', hostWithdraw, consentRequestSent, holderNotified } }
//                   organizer_transfer (ruling 4, any time before 00:00 Warsaw on the race day),
//                   then Plan 4's consent request to the new adult, naming the club as the source
//                   of the data, and „Pakiet przekazany” to the old holder (the new holder's name,
//                   never their address). 422 invalid_person with `fields`, 409 race_day / recipient_minor /
//                   price_differs / duplicate / pending_elsewhere / not_transferable / gone / …
// The owner or an admin of the event's club: a member 403, an outsider or a disabled club 404, an
// unknown target 404. Every change writes one organizer_actions row naming its target; no personal
// value goes into the payload or a log.
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
    const action = body?.action
    if (!ACTIONS.includes(action)) return json({ error: 'Nieznana operacja.', code: 'invalid_action' }, 400, req)
    const target = await targetOf(admin, action, body)
    if (!target) return json(NOT_FOUND, 404, req)
    const loaded = await loadOrganizerEvent(admin, target.eventId, session, { write: true, req })
    if (loaded instanceof Response) return loaded
    const { settings } = loaded
    const actor = session.userId
    const log = (name, targetId, payload = null) => logOrganizerAction(admin, req, {
      actorId: actor, clubId: settings.club_id, eventId: settings.event_id, action: name, target: targetId, payload,
    })

    if (action === 'extend') {
      const until = typeof body.until === 'string' ? new Date(body.until) : null
      const untilFields = () => ({ until: REFUSALS.invalid_until[1] })
      if (!until || Number.isNaN(until.getTime())) return refuse(req, 'invalid_until', untilFields())
      const { data, error } = await admin.rpc('extend_order_window', {
        p_order_id: target.orderId, p_until: until.toISOString(), p_actor: actor,
      })
      if (error) return refusalOrThrow(req, error, untilFields)
      await log('window_extended', target.orderId, { until: data })
      return json({ data: { expiresAt: data } }, 200, req)
    }

    if (action === 'remind_payment') {
      const out = await remindPayment(admin, settings, target.orderId)
      if (out.refused) return refuse(req, out.refused)
      if (out.throttled) {
        return json({ error: 'Przypomnienie o wpłacie można wysłać raz na dobę.', code: 'throttled' }, 429, req,
          { 'Retry-After': String(out.throttled) })
      }
      if (out.failed) {
        return json({ error: 'Nie udało się wysłać przypomnienia. Spróbuj ponownie za chwilę.', code: 'email_failed' }, 502, req)
      }
      await log('payment_reminded', target.orderId, { sent: true })
      return json({ data: { sent: true } }, 200, req)
    }

    if (action === 'cancel') {
      const { data, error } = await admin.rpc('cancel_registration', {
        p_registration_id: target.registrationId, p_reason: 'organizer', p_actor: actor,
      })
      if (error) return refusalOrThrow(req, error)
      const cancelled = data?.cancelled ?? []
      const hostWithdraw = data?.hostWithdraw === true
      await log('registration_cancelled', target.registrationId, { cancelled, hostWithdraw })
      return json({ data: { cancelled, hostWithdraw } }, 200, req)
    }

    if (action === 'edit') {
      const checked = await checkEdit(admin, settings, target.registrationId, body.fields)
      if (checked.invalid) {
        return json({ error: 'Popraw zaznaczone pola.', code: 'invalid_person', fields: checked.invalid }, 422, req)
      }
      const fields = Object.fromEntries(checked.keys.map((k) => [k, body.fields[k]]))
      const { data, error } = await admin.rpc('organizer_edit_registration', {
        p_registration_id: target.registrationId, p_fields: fields, p_actor: actor,
      })
      if (error) {
        return refusalOrThrow(req, error, (code) => (code === 'ineligible'
          ? { birthDate: REFUSALS.ineligible[1] }
          : Object.fromEntries(checked.keys.map((k) => [k, FIELD_MESSAGE]))))
      }
      // Which fields, never their values: the audit keeps no personal data the purge would miss.
      await log('registration_edited', target.registrationId, { fields: checked.keys, changed: data?.changed === true })
      return json({ data: { changed: data?.changed === true, ageGroupLabel: data?.ageGroupLabel ?? null } }, 200, req)
    }

    if (action === 'partner') {
      // Clearing takes an explicit null: a missing or misnamed key must not wipe the attribution.
      if (!('partnerId' in body)) return refuse(req, 'invalid_partner')
      const { partnerId } = body
      if (partnerId !== null && !isUuid(partnerId)) return refuse(req, 'invalid_partner')
      const { data, error } = await admin.rpc('set_registration_partner', {
        p_registration_id: target.registrationId, p_partner_id: partnerId, p_actor: actor,
      })
      if (error) return refusalOrThrow(req, error)
      await log('registration_partner_set', target.registrationId, { partnerId, changed: data?.changed === true })
      return json({ data: { partnerId, changed: data?.changed === true } }, 200, req)
    }

    if (action === 'transfer') {
      // Ruling 4: after transfer_until the organizer types the recipient in, until 00:00 Warsaw on
      // the race day. The new entry is an adult awaiting consent: Plan 4's request follows, naming
      // the organizer as the source of the data (carry T7 c).
      const categoryId = body.categoryId
      const competition = isUuid(categoryId)
        ? await single(admin.from('competitions').select('*').eq('category_id', categoryId).eq('event_id', settings.event_id).maybeSingle())
        : null
      if (!competition) {
        return json({ error: 'Popraw zaznaczone pola.', code: 'invalid_person', fields: { categoryId: 'Wybierz konkurencję.' } }, 422, req)
      }
      const context = (await personContexts(admin, settings, [competition])).get(competition.category_id)
      const checked = validatePerson(body.person ?? {}, { ...context, now: new Date() })
      if (!checked.ok) return json({ error: 'Popraw zaznaczone pola.', code: 'invalid_person', fields: checked.errors }, 422, req)
      const { isMinor: _minor, ...person } = checked.value
      const { data, error } = await callTransferRpc(admin, 'organizer_transfer', {
        p_registration_id: target.registrationId, p_person: person, p_category_id: competition.category_id, p_actor: actor,
      })
      if (error) {
        const known = ORGANIZER_TRANSFER_REFUSALS[error.message]
        if (!known) throw error
        return json({ error: known[1], code: error.message, ...(error.message === 'invalid_person' ? { fields: {} } : {}) }, known[0], req)
      }
      // The entry has moved: nothing below may turn that into a 500 (M-1). A failure is logged by
      // id and reported as not sent; registration-jobs issues a missing consent request and
      // re-sends the old holder's notice.
      let consentRequestSent = false
      let holderNotified = false
      try {
        const club = settings.club_id
          ? await single(admin.from('clubs').select('name').eq('id', settings.club_id).maybeSingle())
          : null
        consentRequestSent = (await issueConsentRequests(admin, [data.registrationId],
          { registeredBy: club?.name?.trim() || 'Organizator zawodów' })) > 0
      } catch (err) {
        console.error('organizer-entry-action: consent request not issued:', `registration ${data.registrationId}`, err?.message)
      }
      // M-2: the old holder is told who has their package now (name only, never the address).
      holderNotified = await sendAcceptedTransferEmail(admin, {
        id: data.transferId, kind: 'organizer', status: 'accepted', event_id: settings.event_id,
        registration_id: target.registrationId, new_registration_id: data.registrationId,
      }, 'holder_emailed_at')
      const hostWithdraw = data.hostWithdraw === true
      // Ids only: the recipient's data stays out of the audit row.
      try {
        await log('registration_transferred', target.registrationId,
          { newRegistrationId: data.registrationId, categoryId: competition.category_id, hostWithdraw })
      } catch (err) {
        console.error('organizer-entry-action: transfer not logged:', target.registrationId, err?.message)
      }
      return json({
        data: { registrationId: data.registrationId, consentState: 'awaiting', hostWithdraw, consentRequestSent, holderNotified },
      }, 200, req)
    }

    // rename_team
    const { data, error } = await admin.rpc('rename_team', { p_team_id: target.teamId, p_name: body.name ?? '', p_actor: actor })
    if (error) return refusalOrThrow(req, error, () => ({ name: TEAM_NAME_MESSAGE }))
    await log('team_renamed', target.teamId)
    return json({ data: { name: data } }, 200, req)
  } catch (err) {
    console.error('organizer-entry-action error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
