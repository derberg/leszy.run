// The club's refund e-mail for an accepted organizer refund (Plan 6). One copy, two callers:
//   - organizer-refund, right after dpay accepted (onFailure 'release': a definite failure gives
//     the claim back, so the job below sends it);
//   - registration-jobs' refund_emails step (D6-23), the catch-up for every accepted organizer
//     refund whose runner_notified_at is still null: a released claim, a claim that failed, a
//     function that died after the settle, or an `unknown` refund the operator resolved to
//     accepted (resolve_organizer_refund). It never releases (onFailure 'keep'): a job e-mail
//     that fails after its claim is alerted, never resent.
//
// At most once: refunds.runner_notified_at is claimed by one UPDATE … WHERE it is null before
// anything is sent. The mail goes to the payer (the order's buyer, whose money it is) and, in the
// same request with a personalization each, to the entry's own adult runner when that address
// differs (ruling S2). A child has no address; the payer is the guardian or paid for them.
// No address reaches a log or an alert.
import { sendEmailToEach } from '../email.js'
import { organizerRefundEmail } from './emails.js'
import { clubSender } from './organizerSender.js'
import { trySend } from './organizerMail.js'
import { raiseAlert } from './orderFlow.js'

async function single(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

/**
 * Sends the refund e-mail once. Never throws.
 * @param {object} admin service-role client
 * @param {{ club_id: string, name: string, contact_email?: string|null }} settings the event's registration_settings
 * @param {{ refundId: string, orderId: string, registrationId: string|null, grosze: number, cancelled: boolean }} refund
 * @param {{ onFailure?: 'release'|'keep' }} [opts]
 * @returns {Promise<'sent'|'claimed_elsewhere'|'no_address'|'failed'|'unknown'>}
 *   failed: nothing went out (with 'release' the claim was given back, with 'keep' it was kept and
 *   `refund_email_failed` raised); unknown: the send timed out, the claim kept and
 *   `refund_email_unknown` raised (the mail may have gone and is never resent blindly).
 */
export async function notifyRefundRunner(admin, settings, { refundId, orderId, registrationId, grosze, cancelled }, { onFailure = 'release' } = {}) {
  const alert = (kind, step, err) => raiseAlert(admin, kind, orderId, { refundId, step, error: String(err?.message ?? err ?? '') })
  try {
    const { data: claimed, error } = await admin.from('refunds').update({ runner_notified_at: new Date().toISOString() })
      .eq('id', refundId).is('runner_notified_at', null).select('id')
    if (error) throw error
    if (!claimed?.length) return 'claimed_elsewhere'
  } catch (err) {
    console.error('refund e-mail: claim failed:', err?.message)
    await alert('refund_email_failed', 'claim', err)
    return 'failed'
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
    if (!to.length) return 'no_address'
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
    console.error('refund e-mail: not built:', err?.message)
    out = { ok: false, unknown: false }
  }
  if (out.ok) return 'sent'
  if (out.unknown) {
    await alert('refund_email_unknown', 'send', 'no answer from the sender')
    return 'unknown'
  }
  if (onFailure === 'keep') {
    await alert('refund_email_failed', 'send', out.status ? `e-mail not accepted (${out.status})` : 'not sent')
    return 'failed'
  }
  try {
    const { error } = await admin.from('refunds').update({ runner_notified_at: null }).eq('id', refundId)
    if (error) throw error
  } catch (err) {
    console.error('refund e-mail: claim not released:', err?.message)
    await alert('refund_email_failed', 'release', err)
  }
  return 'failed'
}

/**
 * The job's view of one accepted organizer refund: everything notifyRefundRunner needs.
 * `cancelled` is what finish_organizer_refund decided: the accepted refunds cover the whole line
 * and the entry is cancelled. → { settings, refund } | null when the line or the event is gone.
 */
export async function refundNoticeArgs(admin, { id, order_id: orderId, order_line_id: lineId, amount }) {
  const line = await single(admin.from('order_lines').select('id, amount, registration_id').eq('id', lineId).maybeSingle())
  const order = await single(admin.from('orders').select('event_id').eq('id', orderId).maybeSingle())
  if (!line || !order) return null
  const settings = await single(admin.from('registration_settings')
    .select('club_id, name, contact_email').eq('event_id', order.event_id).maybeSingle())
  if (!settings) return null
  const [accepted, reg] = await Promise.all([
    single(admin.from('refunds').select('amount').eq('order_line_id', lineId).eq('dpay_status', 'accepted')),
    line.registration_id
      ? single(admin.from('registrations').select('status').eq('id', line.registration_id).maybeSingle())
      : null,
  ])
  const covered = (accepted ?? []).reduce((n, r) => n + r.amount, 0) >= line.amount
  return {
    settings,
    refund: {
      refundId: id, orderId, registrationId: line.registration_id, grosze: amount,
      cancelled: covered && reg?.status === 'cancelled',
    },
  }
}
