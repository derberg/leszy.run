// What happens around the order RPCs: logging a dpay exchange, raising an operator alert,
// reading an order the way the runner sees it, and acting on a confirm_order outcome
// (the confirmation e-mail, or an automatic refund). Shared by create-order, pay-order,
// order-status and dpay-ipn. Runs on the admin (service role) client.
//
// Logging is best effort and never blocks a registration or a confirmation: a failed
// payment_events insert is reported to the console (no payload) and as an operator alert.
// Every payload goes through redactDpay first, because the database refuses an `email`
// key at any depth and an address anywhere in the response text.
import { refundTransaction } from '../dpay.js'
import { sendEmail } from '../email.js'
import { redactDpay } from './redactDpay.js'
import { orderConfirmationEmail, paymentRefundedEmail } from './emails.js'

/**
 * Inserts an operator_alerts row → true when it is stored (or already was, by its key).
 * Never throws. With `dedupeKey` (operator_alerts.dedupe_key,
 * unique) a second alert with the same key is dropped: dpay retries an IPN it did not get
 * `OK` for, and a replay must not page the operator again. confirm_order keys its
 * unknown_attempt / amount_mismatch alerts as '<kind>:<txn>'; use the same form.
 */
export async function raiseAlert(admin, kind, orderId, payload = null, { dedupeKey = null } = {}) {
  try {
    const row = { kind, order_id: orderId ?? null, payload: payload ? redactDpay(payload) : null }
    const table = admin.from('operator_alerts')
    const { error } = dedupeKey
      ? await table.upsert({ ...row, dedupe_key: dedupeKey }, { onConflict: 'dedupe_key', ignoreDuplicates: true })
      : await table.insert(row)
    if (!error) return true
    console.error(`operator alert ${kind} not stored:`, error.message)
  } catch (err) {
    console.error(`operator alert ${kind} not stored:`, err?.message)
  }
  return false
}

/**
 * Appends a payment_events row: kind register | ipn | status_check | refund. `payload` is
 * any object (parsed first, never a raw body); it is redacted here. Never throws.
 */
export async function logPaymentEvent(admin, { kind, orderId = null, attemptId = null, payload = {}, emailSha256 = null, checksumOk = null, response = null }) {
  try {
    const row = {
      kind,
      order_id: orderId,
      payment_attempt_id: attemptId,
      payload: redactDpay(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { value: payload }) ?? {},
      email_sha256: emailSha256,
      checksum_ok: checksumOk,
      response: typeof response === 'string' ? redactDpay(response) : null,
    }
    const { error } = await admin.from('payment_events').insert(row)
    if (!error) return true
    console.error(`payment_events ${kind} not stored:`, error.message)
    await raiseAlert(admin, 'payment_event_log_failed', orderId, { kind, attemptId, error: error.message })
  } catch (err) {
    console.error(`payment_events ${kind} not stored:`, err?.message)
    await raiseAlert(admin, 'payment_event_log_failed', orderId, { kind, attemptId, error: String(err?.message ?? err) })
  }
  return false
}

async function rows(query) {
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

/**
 * The order as its buyer sees it, or null when there is none.
 * → { order, settings, club, lines: [{ registrationId, firstName, lastName, competition,
 *     ageGroupLabel, startTime, amount }] }
 */
export async function loadOrderView(admin, orderId) {
  const { data: order, error } = await admin.from('orders').select('*').eq('id', orderId).maybeSingle()
  if (error) throw error
  if (!order) return null
  const [lineRows, settingsRow] = await Promise.all([
    rows(admin.from('order_lines').select('id, kind, amount, registration_id').eq('order_id', orderId).order('id')),
    admin.from('registration_settings')
      .select('event_id, name, slug, event_date, first_start_time, town_label, place_details, club_id')
      .eq('event_id', order.event_id).maybeSingle(),
  ])
  if (settingsRow.error) throw settingsRow.error
  const settings = settingsRow.data
  const regIds = lineRows.filter((l) => l.registration_id).map((l) => l.registration_id)
  const regs = regIds.length
    ? await rows(admin.from('registrations')
      .select('id, first_name, last_name, email, category_id, age_group_label').in('id', regIds))
    : []
  const catIds = [...new Set(regs.map((r) => r.category_id))]
  const comps = catIds.length
    ? await rows(admin.from('competitions').select('category_id, name, start_time').in('category_id', catIds))
    : []
  const { data: club } = settings?.club_id
    ? await admin.from('clubs').select('name').eq('id', settings.club_id).maybeSingle()
    : { data: null }

  const regById = new Map(regs.map((r) => [r.id, r]))
  const compById = new Map(comps.map((c) => [c.category_id, c]))
  const lines = lineRows.filter((l) => l.kind === 'entry').map((l) => {
    const r = regById.get(l.registration_id) ?? {}
    const c = compById.get(r.category_id) ?? {}
    return {
      registrationId: l.registration_id,
      firstName: r.first_name ?? null,
      lastName: r.last_name ?? null,
      email: r.email ?? null,
      competition: c.name ?? null,
      ageGroupLabel: r.age_group_label ?? null,
      startTime: (c.start_time ?? settings?.first_start_time)?.slice(0, 5) ?? null,
      amount: l.amount,
    }
  })
  return { order, settings, club, lines }
}

/** The amounts block every answer and e-mail shows. */
export function orderAmountsOf(order) {
  return {
    entryTotal: order.entry_total,
    extrasTotal: order.extras_total,
    donation: order.donation,
    supportFee: order.support_fee,
    paymentFee: order.payment_fee,
    total: order.total,
  }
}

// The order page dpay returns the runner to (the same URL the dpay client builds).
function orderPageUrl(orderId) {
  const base = (globalThis.Deno?.env.get('PUBLIC_SITE_URL') ?? '').replace(/\/+$/, '')
  return base ? `${base}/zamowienie/${encodeURIComponent(orderId)}` : null
}

function emailArgs(view) {
  const { order, settings, club, lines } = view
  return {
    event: {
      name: settings?.name ?? '',
      slug: settings?.slug ?? null,
      eventDate: settings?.event_date ?? null,
      place: [settings?.town_label, settings?.place_details].filter(Boolean).join(', ') || null,
    },
    order: {
      id: order.id,
      entryTotal: order.entry_total,
      supportFee: order.support_fee,
      paymentFee: order.payment_fee,
      total: order.total,
      paidTransactionId: order.paid_transaction_id,
      paidAt: order.paid_at,
      expiresAt: order.expires_at,
    },
    lines,
    organizer: { name: club?.name ?? 'Organizator' },
    orderUrl: orderPageUrl(order.id),
  }
}

/** The payment confirmation to the buyer. Best effort: never throws. */
export async function sendOrderConfirmation(admin, orderId) {
  try {
    const view = await loadOrderView(admin, orderId)
    if (!view?.order.buyer_email) return false
    await sendEmail({ to: view.order.buyer_email, ...orderConfirmationEmail(emailArgs(view)) })
    return true
  } catch (err) {
    console.error('order confirmation email failed:', err?.message)
    return false
  }
}

async function sendRefundNotice(admin, orderId, grosze, reason) {
  try {
    const view = await loadOrderView(admin, orderId)
    if (!view?.order.buyer_email) return
    const args = emailArgs(view)
    const build = (r) => paymentRefundedEmail({ event: args.event, order: args.order, amount: grosze, reason: r })
    let mail
    try { mail = build(reason) } catch { mail = build('late') } // a reason the e-mail has no sentence for
    await sendEmail({ to: view.order.buyer_email, ...mail })
  } catch (err) {
    console.error('refund email failed:', err?.message)
  }
}

// The dpay outcomes settle_refund stores, as refundTransaction names them. `pending` (409, a
// refund form already submitted) and `unknown` are never retried automatically.
const SETTLED = new Set(['accepted', 'rejected', 'insufficient_balance', 'pending', 'unknown'])

/**
 * Acts on one confirm_order result. `outcome` is that result ({ outcome, refund? }) plus
 * the `orderId` and `txn` it was called with.
 *   confirmed / late_confirmed  → the confirmation e-mail
 *   double_payment / late_refund → the full refund at dpay (no value: everything left),
 *     logged, settled (settle_refund), the refund e-mail when dpay accepted it, and an
 *     operator alert for an outcome nobody may retry automatically (rejected, pending,
 *     unknown); insufficient_balance is retried by the job
 *   anything else (already_*, unknown_attempt, amount_mismatch) → nothing more; the RPC
 *     already raised its alert
 * The refund e-mail states the refund's own reason (full, duplicate, closed, cancelled,
 * unavailable, double_payment); an unknown one falls back to the neutral 'late' sentence.
 * Never throws: the payment is already decided in the database.
 */
export async function settleConfirmOutcome(admin, cfg, outcome) {
  const { orderId, txn, refund } = outcome ?? {}
  const kind = outcome?.outcome
  if (kind === 'confirmed' || kind === 'late_confirmed') {
    await sendOrderConfirmation(admin, orderId)
    return { emailed: true }
  }
  if ((kind !== 'double_payment' && kind !== 'late_refund') || !refund) return {}

  let result
  try {
    result = await refundTransaction(cfg, { transactionId: txn, messageId: refund.messageId })
  } catch (err) {
    result = { outcome: 'unknown', httpStatus: null, message: String(err?.message ?? err) }
  }
  await logPaymentEvent(admin, {
    kind: 'refund',
    orderId,
    attemptId: refund.attemptId ?? null,
    payload: {
      refundId: refund.refundId, reason: refund.reason, grosze: refund.grosze, txn,
      outcome: result.outcome, httpStatus: result.httpStatus, message: result.message,
    },
  })
  try {
    const { error } = await admin.rpc('settle_refund', { p_refund_id: refund.refundId, p_outcome: SETTLED.has(result.outcome) ? result.outcome : 'unknown' })
    if (error) throw error
  } catch (err) {
    console.error('settle_refund failed:', err?.message)
    await raiseAlert(admin, 'refund_settle_failed', orderId, { refundId: refund.refundId, outcome: result.outcome })
  }
  if (result.outcome === 'accepted') {
    await sendRefundNotice(admin, orderId, refund.grosze, refund.reason === 'double_payment' ? 'double' : (refund.reason ?? 'late'))
  } else if (result.outcome !== 'insufficient_balance') {
    await raiseAlert(admin, `refund_${result.outcome}`, orderId, {
      refundId: refund.refundId, txn, grosze: refund.grosze, reason: refund.reason, httpStatus: result.httpStatus,
    })
  }
  return { refund: result.outcome }
}
