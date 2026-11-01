import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { logOrganizerAction } from '../_shared/organizer.js'
import { sendEmailToEach } from '../_shared/email.js'
import { dpayConfig, DpayConfigError } from '../_shared/dpay.js'
import { isUuid, loadOrganizerEvent } from '../_shared/registration/organizerEvent.js'
import { claimRefundRequest, executeRefund, PAYMENTS_OFF, raiseAlert } from '../_shared/registration/orderFlow.js'
import { organizerRefundEmail } from '../_shared/registration/emails.js'
import { clubSender } from '../_shared/registration/organizerSender.js'
import { formatPln } from '../_shared/registration/money.js'
import { trySend } from '../_shared/registration/organizerMail.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

const NOT_FOUND = { error: 'Not found' }
const UNCONFIRMED = 'Zwrot niepotwierdzony.'
const INSUFFICIENT = 'Operator płatności odrzucił zwrot: brak środków.'
const REJECTED = 'Operator płatności odrzucił zwrot.'
const exceedsCopy = (grosze) => `Kwota przekracza możliwą do zwrotu: ${formatPln(grosze)}.`

// reserve_organizer_refund's refusals, beside `exceeds:<grosze>`.
const RESERVE_REFUSALS = {
  race_day: [409, 'Zwroty są zamknięte od dnia zawodów.'],
  not_paid: [409, 'To zgłoszenie nie jest opłacone.'],
  invalid_amount: [422, 'Podaj kwotę zwrotu.'],
  invalid_request_key: [400, 'Nieprawidłowe żądanie.'],
  request_key_mismatch: [409, 'To żądanie zwrotu dotyczy innej kwoty. Otwórz okno zwrotu jeszcze raz.'],
  not_found: [404, NOT_FOUND.error],
}

/** The answer for a refund in a given state: what this call learned, or a replay of the row. */
function answerFor(req, refundId, status, cancelled = []) {
  if (status === 'accepted') return json({ data: { status: 'accepted', cancelled, refundId } }, 200, req)
  if (status === 'insufficient_balance') return json({ error: INSUFFICIENT, code: status, refundId }, 409, req)
  if (status === 'rejected') return json({ error: REJECTED, code: status, refundId }, 409, req)
  // pending (dpay 409) or unknown (timeout, 5xx, 410): only a person at the dpay panel can tell.
  return json({ data: { status: 'unknown', refundId }, message: UNCONFIRMED }, 202, req)
}

function reserveRefusal(req, error) {
  const msg = error?.message ?? ''
  const exceeds = /^exceeds:(\d+)$/.exec(msg)
  if (exceeds) {
    const remaining = Number(exceeds[1])
    return json({ error: exceedsCopy(remaining), code: 'exceeds', remaining }, 409, req)
  }
  if (RESERVE_REFUSALS[msg]) {
    const [status, text] = RESERVE_REFUSALS[msg]
    return json({ error: text, code: msg }, status, req)
  }
  return null
}

async function single(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

/**
 * The club's refund e-mail, at most once: runner_notified_at is claimed by one UPDATE before
 * sending. It goes to the payer (the order's buyer, whose money it is) and, in the same request
 * with a personalization each, to the entry's own adult runner when that address differs (ruling
 * S2): an added adult whose entry is refunded and cancelled must hear of it. A child has no
 * address; the payer is the guardian or paid for them.
 * Never throws: dpay's acceptance is already stored, so nothing here may become a 500 (review I2).
 *   - the claim fails → logged and alerted (`refund_email_failed`), nothing sent; Task 5's job
 *     finds runner_notified_at null and sends it
 *   - the send is refused → the claim is given back for that job (an alert only if it cannot be)
 *   - the send timed out (deliveryUnknown) → the claim is kept and the operator alerted
 *     (`refund_email_unknown`): the mail may have gone, and a second copy is not resent blindly
 * No address reaches a log or an alert.
 */
async function notifyRunner(admin, settings, { refundId, orderId, registrationId, grosze, cancelled }) {
  const alert = (kind, step, err) => raiseAlert(admin, kind, orderId, { refundId, step, error: String(err?.message ?? err ?? '') })
  try {
    const { data: claimed, error } = await admin.from('refunds').update({ runner_notified_at: new Date().toISOString() })
      .eq('id', refundId).is('runner_notified_at', null).select('id')
    if (error) throw error
    if (!claimed?.length) return
  } catch (err) {
    console.error('organizer-refund: e-mail claim failed:', err?.message)
    await alert('refund_email_failed', 'claim', err)
    return
  }
  let out
  try {
    const [order, reg, club] = await Promise.all([
      single(admin.from('orders').select('buyer_email').eq('id', orderId).single()),
      registrationId
        ? single(admin.from('registrations').select('first_name, last_name, email').eq('id', registrationId).maybeSingle())
        : null,
      single(admin.from('clubs').select('name').eq('id', settings.club_id).single()),
    ])
    const to = [...new Set([order?.buyer_email, reg?.email].filter(Boolean).map((a) => a.toLowerCase()))]
    if (!to.length) return
    const deleted = reg?.first_name === 'Usunięte konto'
    const mail = organizerRefundEmail({
      event: { name: settings.name },
      person: deleted || !reg ? null : { firstName: reg.first_name, lastName: reg.last_name },
      grosze,
      cancelled,
      organizer: { name: club.name },
    })
    const sender = await clubSender(admin, settings)
    out = await trySend(() => sendEmailToEach(to, { ...mail, ...sender }))
  } catch (err) {
    console.error('organizer-refund: refund e-mail not built:', err?.message)
    out = { ok: false, unknown: false }
  }
  if (out.ok) return
  if (out.unknown) {
    await alert('refund_email_unknown', 'send', 'no answer from the sender')
    return
  }
  try {
    const { error } = await admin.from('refunds').update({ runner_notified_at: null }).eq('id', refundId)
    if (error) throw error
  } catch (err) {
    console.error('organizer-refund: e-mail claim not released:', err?.message)
    await alert('refund_email_failed', 'release', err)
  }
}

/**
 * After finish_organizer_refund stored dpay's answer: the alert, the audit and the e-mail, then
 * the answer for the stored state. Never throws (review I2): the organizer who sees a 500 for
 * money that already left reopens the dialog, and a new requestKey refunds again.
 * already_settled carries the stored state itself (`finished.status`), so nothing is re-read.
 */
async function afterSettle(admin, req, settings, { finished, outcome, refundId, refund, line, grosze, transactionId, audit }) {
  const status = finished.status ?? outcome
  if (finished.settled === 'already_settled') return answerFor(req, refundId, status)
  const cancelled = finished.cancelled ?? []
  try {
    if (outcome === 'insufficient_balance') {
      // Never retried for an organizer refund (ruling 3): the operator hears of it here.
      await raiseAlert(admin, 'refund_insufficient_balance', refund.order_id, {
        refundId, txn: transactionId, grosze, reason: 'organizer',
      })
    }
    await logOrganizerAction(admin, req, {
      ...audit, action: 'refund_settled', payload: { status, grosze, cancelled },
    })
    if (outcome === 'accepted') {
      await notifyRunner(admin, settings, {
        refundId, orderId: refund.order_id, registrationId: line.registration_id, grosze, cancelled: cancelled.length > 0,
      })
    }
  } catch (err) {
    console.error('organizer-refund: after settle:', err?.message)
    await raiseAlert(admin, 'refund_followup_failed', refund.order_id, { refundId, status, error: String(err?.message ?? err) })
  }
  return answerFor(req, refundId, status, cancelled)
}

// POST { lineId, grosze, requestKey } → refunds part of a paid order line (Plan 6, D6-18).
//   reserve_organizer_refund (the money is reserved on the line before dpay is called; the same
//   requestKey is a replay, never a second call) → claimRefundRequest (P3-R10: at most one dpay
//   call) → executeRefund(…, { partial, organizer }), which logs the exchange, stores dpay's
//   answer through finish_organizer_refund and alerts rejected / pending / unknown. A 406 is
//   alerted here and never retried: the organizer retries by hand.
//   200 { data: { status: 'accepted', cancelled: [registrationId], refundId } } and the club's
//       e-mail to the payer and the entry's adult runner, claimed on runner_notified_at. Once
//       dpay's answer is stored, the answer is that refund's state whatever fails after it (the
//       e-mail, the audit): a failure is logged and alerted, never a 500 (review I2)
//   202 { data: { status: 'unknown', refundId }, message: „Zwrot niepotwierdzony.” } the money stays
//       reserved and the operator resolves it; the runner is told nothing yet
//   409 exceeds (with remaining), race_day, not_paid, insufficient_balance, rejected,
//       request_key_mismatch; 422 invalid_amount; 503 dpay not configured
// The owner or an admin of the event's club: a member 403, an outsider or a disabled club 404,
// an unknown line 404. Every reservation and every outcome this call stored is in organizer_actions.
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
    const { lineId, grosze, requestKey } = body ?? {}
    if (!isUuid(lineId)) return json(NOT_FOUND, 404, req)
    const line = await single(admin.from('order_lines')
      .select('id, order_id, kind, registration_id, orders!inner(event_id)').eq('id', lineId).maybeSingle())
    if (!line) return json(NOT_FOUND, 404, req)
    const loaded = await loadOrganizerEvent(admin, line.orders.event_id, session, { write: true, req })
    if (loaded instanceof Response) return loaded
    const { settings } = loaded

    if (!Number.isInteger(grosze) || grosze <= 0) {
      return json({ error: RESERVE_REFUSALS.invalid_amount[1], code: 'invalid_amount' }, 422, req)
    }
    if (typeof requestKey !== 'string') {
      return json({ error: RESERVE_REFUSALS.invalid_request_key[1], code: 'invalid_request_key' }, 400, req)
    }

    let cfg
    try {
      cfg = dpayConfig(Deno.env)
    } catch (err) {
      if (err instanceof DpayConfigError) {
        console.error('organizer-refund: dpay not configured:', err.message)
        return json({ error: PAYMENTS_OFF, code: 'dpay_not_configured' }, 503, req)
      }
      throw err
    }

    const { data: reserved, error: rErr } = await admin.rpc('reserve_organizer_refund', {
      p_line_id: line.id, p_grosze: grosze, p_actor: session.userId, p_request_key: requestKey,
    })
    if (rErr) {
      const refused = reserveRefusal(req, rErr)
      if (refused) return refused
      throw rErr
    }
    const { refundId, messageId, transactionId } = reserved
    const audit = { actorId: session.userId, clubId: settings.club_id, eventId: settings.event_id, target: refundId }
    if (!reserved.replay) {
      await logOrganizerAction(admin, req, {
        ...audit, action: 'refund_requested',
        payload: { lineId: line.id, orderId: line.order_id, registrationId: line.registration_id, grosze },
      })
    }

    const refund = await single(admin.from('refunds')
      .select('id, order_id, payment_attempt_id, dpay_status').eq('id', refundId).single())
    // A replay, or a refund another request claimed first: dpay is never called twice (ruling 5).
    if (reserved.replay || !(await claimRefundRequest(admin, refundId))) return answerFor(req, refundId, refund.dpay_status)

    let finished = null
    const outcome = await executeRefund(admin, cfg, {
      orderId: refund.order_id, txn: transactionId, refundId, messageId, attemptId: refund.payment_attempt_id,
      grosze, reason: 'organizer', partial: true, source: 'organizer', organizer: true,
      onSettled: (data) => { finished = data },
    })
    if (!finished) {
      // The settle step failed (executeRefund alerted it): nothing is known to be stored.
      return answerFor(req, refundId, 'unknown')
    }
    return await afterSettle(admin, req, settings, {
      finished, outcome, refundId, refund, line, grosze, transactionId, audit,
    })
  } catch (err) {
    console.error('organizer-refund error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
