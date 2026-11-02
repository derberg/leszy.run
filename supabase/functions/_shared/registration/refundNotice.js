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
// differs (ruling S2). A child has no address; the payer is the guardian or paid for them. A team's
// refund goes to its captain only (user decision 2026-11-02): a line of a member who is not the
// captain (an extra) mails the payer and the captain, never the member.
// A line a package transfer moved gets two separate sends, one per copy (Plan 7): the claim covers
// both, so it is given back only when neither copy can have gone out. When one copy went out and
// the other did not, the claim is kept and the alert names the failed copy (`copy`) and its own
// status: releasing it would send the delivered copy a second time (follow-up NB-1).
// No address reaches a log or an alert.
import { sendEmailToEach } from '../email.js'
import { organizerRefundEmail } from './emails.js'
import { clubSender } from './organizerSender.js'
import { trySend } from './organizerMail.js'
import { raiseAlert } from './orderFlow.js'
import { transferredRegistrationIds } from './transfers.js'

async function single(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

/**
 * The runner's address for a refund of this registration's line: its own, or for a team member who
 * is not the captain, the captain's (a team's refund e-mail goes to the captain only, user decision
 * 2026-11-02). Null when there is none (a child, a deleted account).
 */
async function refundRunnerAddress(admin, registrationId, reg) {
  if (!reg?.team_id) return reg?.email ?? null
  const team = await single(admin.from('teams').select('captain_registration_id').eq('id', reg.team_id).maybeSingle())
  if (!team?.captain_registration_id || team.captain_registration_id === registrationId) return reg.email ?? null
  const captain = await single(admin.from('registrations').select('email').eq('id', team.captain_registration_id).maybeSingle())
  return captain?.email ?? null
}

/**
 * Sends the refund e-mail once. Never throws.
 * @param {object} admin service-role client
 * @param {{ club_id: string, name: string, contact_email?: string|null }} settings the event's registration_settings
 * @param {{ refundId: string, orderId: string, registrationId: string|null, grosze: number, cancelled: boolean }} refund
 * @param {{ onFailure?: 'release'|'keep' }} [opts]
 * @returns {Promise<'sent'|'claimed_elsewhere'|'no_address'|'failed'|'unknown'>}
 *   failed: a copy did not go out. When nothing went out, with 'release' the claim was given back,
 *   with 'keep' it was kept and `refund_email_failed` raised; when the other copy of a moved line
 *   went out, the claim is kept and `refund_email_failed` names the failed copy, whatever
 *   `onFailure` says. unknown: a send timed out, the claim kept and `refund_email_unknown` raised
 *   (the mail may have gone and is never resent blindly).
 */
export async function notifyRefundRunner(admin, settings, { refundId, orderId, registrationId, grosze, cancelled }, { onFailure = 'release' } = {}) {
  const alert = (kind, step, err, dedupeKey = null, extra = {}) =>
    raiseAlert(admin, kind, orderId, { refundId, step, error: String(err?.message ?? err ?? ''), ...extra }, { dedupeKey })
  const notAccepted = (status) => (status ? `e-mail not accepted (${status})` : 'not sent')
  try {
    const { data: claimed, error } = await admin.from('refunds').update({ runner_notified_at: new Date().toISOString() })
      .eq('id', refundId).is('runner_notified_at', null).select('id')
    if (error) throw error
    if (!claimed?.length) return 'claimed_elsewhere'
  } catch (err) {
    console.error('refund e-mail: claim failed:', err?.message)
    // Review M5: the job meets a failing claim every 15 min; one alert per refund is enough.
    await alert('refund_email_failed', 'claim', err, `refund_email_claim:${refundId}`)
    return 'failed'
  }
  // One entry per send: { copy, ok, unknown, status }. `copy` is 'payer' or 'holder' for a moved
  // line's two copies, null for the one message of every other refund.
  let sends
  try {
    const [order, reg, club] = await Promise.all([
      single(admin.from('orders').select('buyer_email').eq('id', orderId).single()),
      registrationId
        ? single(admin.from('registrations').select('first_name, last_name, email, team_id').eq('id', registrationId).maybeSingle())
        : null,
      single(admin.from('clubs').select('name').eq('id', settings.club_id).single()),
    ])
    // A team's refund goes to its captain only (user decision 2026-11-02), never to another member:
    // a member's own line (an extra) is the captain's to hear about, like the team's fee.
    const runnerEmail = await refundRunnerAddress(admin, registrationId, reg)
    const to = [...new Set([order?.buyer_email, runnerEmail].filter(Boolean).map((a) => a.toLowerCase()))]
    if (!to.length) return 'no_address'
    const deleted = reg?.first_name === 'Usunięte konto'
    const named = deleted || !reg ? null : { firstName: reg.first_name, lastName: reg.last_name }
    const base = { event: { name: settings.name }, grosze, cancelled, organizer: { name: club.name } }
    const sender = await clubSender(admin, settings)
    // A line a package transfer moved (Plan 7): its holder did not pay. The holder's copy says the
    // money goes back to whoever paid, also when the payer's address is gone (an account deleted,
    // NB-2): the money still goes to the payer's card, never the holder's. The payer's copy, sent
    // only when there is a payer address, names the holder only after a runner's transfer
    // (ruling N-1). Otherwise one message to both, as before.
    const kind = registrationId ? (await transferredRegistrationIds(admin, [registrationId])).get(registrationId) : undefined
    const buyer = order?.buyer_email?.toLowerCase() ?? null
    const holder = runnerEmail?.toLowerCase() ?? null
    if (kind && buyer !== holder) {
      const copies = []
      if (buyer) copies.push(['payer', buyer, organizerRefundEmail({ ...base, person: kind === 'organizer' ? null : named })])
      if (holder) copies.push(['holder', holder, organizerRefundEmail({ ...base, person: named, paidByOther: true })])
      sends = []
      for (const [copy, address, mail] of copies) {
        sends.push({ copy, ...(await trySend(() => sendEmailToEach([address], { ...mail, ...sender }))) })
      }
    } else {
      const mail = organizerRefundEmail({ ...base, person: named })
      sends = [{ copy: null, ...(await trySend(() => sendEmailToEach(to, { ...mail, ...sender }))) }]
    }
  } catch (err) {
    console.error('refund e-mail: not built:', err?.message)
    sends = [{ copy: null, ok: false, unknown: false }]
  }
  if (sends.every((s) => s.ok)) return 'sent'
  const copyOf = (s) => (s.copy ? { copy: s.copy } : {})
  // A copy that went out, or may have (a timeout), must never be sent again: the claim stays and
  // every copy that did not go out is alerted on its own, with its own status.
  if (sends.some((s) => s.ok || s.unknown)) {
    let unknown = false
    for (const s of sends.filter((x) => !x.ok)) {
      if (s.unknown) {
        unknown = true
        await alert('refund_email_unknown', 'send', 'no answer from the sender', null, copyOf(s))
      } else {
        await alert('refund_email_failed', 'send', notAccepted(s.status), null, copyOf(s))
      }
    }
    return unknown ? 'unknown' : 'failed'
  }
  // Nothing went out: the claim may be given back, and every copy will be sent again.
  if (onFailure === 'keep') {
    for (const s of sends) await alert('refund_email_failed', 'send', notAccepted(s.status), null, copyOf(s))
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
