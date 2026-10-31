// What happens around the order RPCs: logging a dpay exchange, raising an operator alert,
// reading an order the way the runner sees it, and acting on a confirm_order outcome
// (the confirmation e-mail, or an automatic refund), and starting a dpay payment for an order.
// Shared by create-order, register-team, pay-order, order-status and dpay-ipn. Runs on the admin
// (service role) client.
//
// Logging is best effort and never blocks a registration or a confirmation: a failed
// payment_events insert is reported to the console (no payload) and as an operator alert.
// Every payload goes through redactDpay first, because the database refuses an `email`
// key at any depth and an address anywhere in the response text.
import { refundTransaction, registerTransaction, transactionDetails } from '../dpay.js'
import { sendEmail } from '../email.js'
import { redactDpay } from './redactDpay.js'
import { orderConfirmationEmail, paymentRefundedEmail, teamConfirmationEmail } from './emails.js'
import { issueOrderConsentRequests, publicSite } from './consentRequests.js'
import { registrationRole } from './group.js'
import { kidsGroupLabels } from './kidsGroupLabels.js'

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

export const PAYMENTS_OFF = 'Płatności online są chwilowo niedostępne.'
export const DPAY_DOWN = 'Nie udało się połączyć z operatorem płatności. Spróbuj ponownie.'

/**
 * Registers a dpay transaction for a pending order and hands out its address (D5-24): the logged
 * register call, then add_payment_attempt, which re-checks under the order lock.
 * → { redirectUrl }, or { refused } and the caller words the answer:
 *   'dpay_unconfigured' (cfg is null), 'dpay_unavailable' (dpay did not register it),
 *   'full' / 'not_payable' (add_payment_attempt refused).
 * Any other add_payment_attempt error is thrown.
 * `cancelOnFailure` is for an order made by this same request: unless a redirect was handed out,
 * for any reason including a throw, the order is cancelled (P3-R7), and a failed cancel raises
 * `cancel_failed`. pay-order leaves it off, because a pending order keeps its payment window.
 */
export async function startPaymentAttempt(admin, cfg, { orderId, total, cancelOnFailure = false }) {
  let handedOut = false
  let cancelReason = 'create_order_aborted'
  try {
    if (!cfg) {
      cancelReason = 'dpay_unconfigured'
      return { refused: 'dpay_unconfigured' }
    }
    let txn
    try {
      txn = await registerTransaction(cfg, { orderId, grosze: total })
    } catch (err) {
      console.error('payment attempt: dpay register failed:', err?.httpStatus ?? null, err?.message)
      await logPaymentEvent(admin, {
        kind: 'register', orderId,
        payload: { ok: false, httpStatus: err?.httpStatus ?? null, message: err?.message ?? null, grosze: total },
      })
      cancelReason = 'dpay_register_failed'
      return { refused: 'dpay_unavailable' }
    }

    const { data: attemptId, error: aErr } = await admin.rpc('add_payment_attempt', {
      p_order_id: orderId, p_txn: txn.transactionId, p_grosze: total,
    })
    if (aErr) {
      // A transaction we never hand out: nobody can pay it.
      console.error('payment attempt: add_payment_attempt failed:', aErr.message)
      if (aErr.message === 'full' || aErr.message === 'not_payable') {
        cancelReason = 'attempt_refused'
        return { refused: aErr.message }
      }
      throw aErr
    }
    await logPaymentEvent(admin, {
      kind: 'register', orderId, attemptId,
      payload: { ok: true, transactionId: txn.transactionId, redirectUrl: txn.redirectUrl, grosze: total },
    })
    handedOut = true
    return { redirectUrl: txn.redirectUrl }
  } finally {
    if (cancelOnFailure && !handedOut) {
      try {
        const { error: cErr } = await admin.rpc('cancel_order', { p_order_id: orderId, p_reason: cancelReason })
        if (cErr) throw cErr
      } catch (err) {
        console.error('payment attempt: cancel_order failed:', err?.message)
        await raiseAlert(admin, 'cancel_failed', orderId, { reason: cancelReason })
      }
    }
  }
}

// A name matched case-insensitively and literally (a % or _ in it is not a wildcard).
const likeLiteral = (v) => String(v).replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * A live registration of the group (any adult's address, or a child by name and birth date) in
 * this buyer's own pending order (a resubmit after leaving the dpay page, or a double click) →
 * that order's id, else null (P3-R8, D4-27).
 */
export async function ownPendingOrder(admin, eventId, people, profileId) {
  const emails = people.map((p) => p.email).filter(Boolean)
  const found = emails.length
    ? await rows(admin.from('registrations').select('order_id')
      .eq('event_id', eventId).in('email', emails).eq('status', 'pending_payment'))
    : []
  for (const m of people.filter((p) => p.role === 'minor')) {
    found.push(...await rows(admin.from('registrations').select('order_id, first_name, last_name')
      .eq('event_id', eventId).is('email', null).eq('birth_date', m.birthDate).eq('status', 'pending_payment')
      .ilike('first_name', likeLiteral(m.firstName)).ilike('last_name', likeLiteral(m.lastName))))
  }
  const ids = [...new Set(found.map((r) => r.order_id).filter(Boolean))]
  if (!ids.length) return null
  const { data: orders, error: oErr } = await admin.from('orders')
    .select('id').in('id', ids).eq('status', 'pending').eq('buyer_profile_id', profileId).limit(1)
  if (oErr) throw oErr
  return orders?.[0]?.id ?? null
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
      .select('event_id, name, slug, event_date, first_start_time, town_label, place_details, club_id, closes_at')
      .eq('event_id', order.event_id).maybeSingle(),
  ])
  if (settingsRow.error) throw settingsRow.error
  const settings = settingsRow.data
  const regIds = lineRows.filter((l) => l.registration_id).map((l) => l.registration_id)
  const regs = regIds.length
    ? await rows(admin.from('registrations')
      .select('id, first_name, last_name, email, category_id, age_group_label, kids_group_id, consent_state, profile_id, registered_by_profile_id, guardian_name, guardian_profile_id, guardian_removed_at')
      .in('id', regIds))
    : []
  const catIds = [...new Set(regs.map((r) => r.category_id))]
  const comps = catIds.length
    ? await rows(admin.from('competitions').select('category_id, name, start_time').in('category_id', catIds))
    : []
  const { data: club } = settings?.club_id
    ? await admin.from('clubs').select('name').eq('id', settings.club_id).maybeSingle()
    : { data: null }

  const kidsLabel = await kidsGroupLabels(admin, regs)
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
      kidsGroupLabel: (r.kids_group_id && kidsLabel.get(r.kids_group_id)) || null,
      profileId: r.profile_id ?? null,
      startTime: (c.start_time ?? settings?.first_start_time)?.slice(0, 5) ?? null,
      amount: l.amount,
      role: l.registration_id ? registrationRole(r) : null,
      consentState: r.consent_state ?? null,
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
    total: order.total,
  }
}

// The order page dpay returns the runner to (the same URL the dpay client builds).
function orderPageUrl(orderId) {
  const base = (globalThis.Deno?.env.get('PUBLIC_SITE_URL') ?? '').replace(/\/+$/, '')
  return base ? `${base}/zamowienie/${encodeURIComponent(orderId)}` : null
}

/** The arguments every order e-mail builder takes, from loadOrderView's result. */
export function orderEmailArgs(view) {
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

/**
 * Everything teamConfirmationEmail needs but `paid`, from the stored team: its live members,
 * the captain first, then by leg, then by name (a team's rows share one created_at).
 */
async function teamEmailArgs(admin, teamId) {
  const { data: team, error } = await admin.from('teams')
    .select('id, name, event_id, category_id, captain_registration_id').eq('id', teamId).single()
  if (error) throw error
  const [regs, settingsRow, compRow] = await Promise.all([
    rows(admin.from('registrations')
      .select('id, first_name, last_name, age_group_label, team_leg, consent_state, profile_id, registered_by_profile_id, guardian_name, guardian_profile_id, guardian_removed_at')
      .eq('team_id', teamId).eq('status', 'confirmed')),
    admin.from('registration_settings').select('name, slug, event_date, town_label, place_details').eq('event_id', team.event_id).single(),
    admin.from('competitions').select('name').eq('category_id', team.category_id).single(),
  ])
  if (settingsRow.error) throw settingsRow.error
  if (compRow.error) throw compRow.error
  const settings = settingsRow.data
  const rank = (r) => (r.id === team.captain_registration_id ? -1 : r.team_leg ?? Number.MAX_SAFE_INTEGER)
  const members = regs
    .sort((a, b) => rank(a) - rank(b) || `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`, 'pl'))
    .map((r) => ({
      firstName: r.first_name,
      lastName: r.last_name,
      ageGroupLabel: r.age_group_label,
      role: r.id === team.captain_registration_id ? 'self' : registrationRole(r),
    }))
  return {
    event: {
      name: settings.name,
      slug: settings.slug,
      eventDate: settings.event_date,
      place: [settings.town_label, settings.place_details].filter(Boolean).join(', ') || null,
    },
    team: { name: team.name, competition: compRow.data.name },
    members,
    link: `${publicSite()}/events/${encodeURIComponent(settings.slug)}/druzyna/${encodeURIComponent(team.id)}`,
  }
}

/**
 * A free team's confirmation to its captain. A team with an order goes through
 * sendOrderConfirmation instead. Best effort: never throws, the team stands either way.
 */
export async function sendTeamConfirmation(admin, teamId, to) {
  try {
    const res = await sendEmail({ to, ...teamConfirmationEmail({ ...(await teamEmailArgs(admin, teamId)), paid: null }) })
    if (res && res.ok === false) throw new Error(`e-mail not accepted (${res.status})`)
  } catch (err) {
    console.error('team confirmation email failed:', err?.message)
  }
}

// The order's confirmation: a team's when the order holds one (D5-25), so the first send and the
// job's resend are the same e-mail. A 0 zł order paid nothing, so it says nothing of money (P3-R9).
async function confirmationMail(admin, view) {
  const args = orderEmailArgs(view)
  const [held] = await rows(admin.from('registrations').select('team_id')
    .eq('order_id', view.order.id).not('team_id', 'is', null).limit(1))
  if (!held) return orderConfirmationEmail(args)
  const paid = view.order.total > 0 ? { order: args.order, organizer: args.organizer, orderUrl: args.orderUrl } : null
  return teamConfirmationEmail({ ...(await teamEmailArgs(admin, held.team_id)), paid })
}

/**
 * The payment confirmation to the buyer, at most once (P3-R10). Best effort: never throws.
 * Claim, then send: orders.confirmation_sent_at is stamped by one UPDATE … WHERE it is null
 * before the e-mail goes out, and a second caller that finds it stamped sends nothing.
 * A send that fails here gives the claim back, so registration-jobs sends it 10 minutes after
 * payment; if this function dies between the claim and the send, nothing is resent (at most
 * once beats twice). `claimed: true` is the job, which claimed already: a failure there is
 * alerted, never resent.
 */
export async function sendOrderConfirmation(admin, orderId, { claimed = false } = {}) {
  let mine = claimed
  try {
    if (!claimed) {
      const { data, error } = await admin.from('orders').update({ confirmation_sent_at: new Date().toISOString() })
        .eq('id', orderId).is('confirmation_sent_at', null).select('id')
      if (error) throw error
      if (!data?.length) return false
      mine = true
    }
    const view = await loadOrderView(admin, orderId)
    if (!view?.order.buyer_email) return false
    const res = await sendEmail({ to: view.order.buyer_email, ...await confirmationMail(admin, view) })
    if (res && res.ok === false) throw new Error(`e-mail not accepted (${res.status})`)
    return true
  } catch (err) {
    console.error('order confirmation email failed:', err?.message)
    if (claimed) {
      await raiseAlert(admin, 'confirmation_email_failed', orderId, { error: String(err?.message ?? err) })
    } else if (mine) {
      const { error } = await admin.from('orders').update({ confirmation_sent_at: null }).eq('id', orderId)
      if (error) console.error('confirmation claim not released:', error.message)
    }
    return false
  }
}

async function sendRefundNotice(admin, orderId, grosze, reason) {
  try {
    const view = await loadOrderView(admin, orderId)
    if (!view?.order.buyer_email) return
    const args = orderEmailArgs(view)
    const build = (r) => paymentRefundedEmail({ event: args.event, order: args.order, amount: grosze, reason: r })
    let mail
    try { mail = build(reason) } catch { mail = build('late') } // a reason the e-mail has no sentence for
    const res = await sendEmail({ to: view.order.buyer_email, ...mail })
    if (res && res.ok === false) throw new Error(`e-mail not accepted (${res.status})`)
  } catch (err) {
    // Nobody else tells the runner the money came back: the operator must (final review M6).
    console.error('refund email failed:', err?.message)
    await raiseAlert(admin, 'email_failed', orderId, { template: 'refund', error: String(err?.message ?? err) })
  }
}

// The dpay outcomes settle_refund stores, as refundTransaction names them. `pending` (409, a
// refund form already submitted) and `unknown` are never retried automatically.
const SETTLED = new Set(['accepted', 'rejected', 'insufficient_balance', 'pending', 'unknown'])

/**
 * Acts on one confirm_order result. `outcome` is that result ({ outcome, refund? }) plus
 * the `orderId` and `txn` it was called with.
 *   confirmed / late_confirmed  → the confirmation e-mail, then the consent requests to the
 *     group's added adults (issueOrderConsentRequests, at most once each)
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
    // Plan 4 ruling 4: the added adults of a paid group are asked now that it is paid, never
    // before. issue_consent_request claims each request once, so a replay sends nothing.
    const consentRequests = await issueOrderConsentRequests(admin, orderId)
    return { emailed: true, consentRequests }
  }
  if ((kind !== 'double_payment' && kind !== 'late_refund') || !refund) return {}

  // P3-R10: claim the call. Of two callers holding the same refund (a crash replay, a second
  // isolate), only the one whose UPDATE stamps requested_at calls dpay.
  try {
    if (!(await claimRefundRequest(admin, refund.refundId))) return { refund: 'already_requested' }
  } catch (err) {
    console.error('refund claim failed:', err?.message)
    await raiseAlert(admin, 'refund_claim_failed', orderId, { refundId: refund.refundId, error: String(err?.message ?? err) })
    return { refund: 'not_requested' }
  }
  const sent = await executeRefund(admin, cfg, {
    orderId, txn, refundId: refund.refundId, messageId: refund.messageId, attemptId: refund.attemptId ?? null,
    grosze: refund.grosze, reason: refund.reason,
  })
  return { refund: sent }
}

/**
 * P3-R10: stamps refunds.requested_at for one refund → true when this caller stamped it (and so
 * may call dpay), false when it was stamped already. Throws on a database error.
 */
export async function claimRefundRequest(admin, refundId) {
  const { data, error } = await admin.from('refunds').update({ requested_at: new Date().toISOString() })
    .eq('id', refundId).is('requested_at', null).select('id')
  if (error) throw error
  return Boolean(data?.length)
}

/**
 * One dpay refund call for a refund this caller has CLAIMED (claimRefundRequest, or the retry
 * job's claim_refund_retries), then its log row, settle_refund, and the follow-up: the refund
 * e-mail when dpay accepted, an operator alert for an outcome nobody may retry automatically
 * (rejected, pending, unknown). insufficient_balance is left to the retry job.
 * `grosze` is sent as the refund value only with `partial: true`; otherwise dpay refunds what is
 * left of the transaction (an automatic refund is always the whole payment).
 * → the outcome string. Never throws.
 */
export async function executeRefund(admin, cfg, { orderId, txn, refundId, messageId, attemptId = null, grosze, reason, partial = false, source = null }) {
  let result
  try {
    result = await refundTransaction(cfg, { transactionId: txn, messageId, ...(partial ? { grosze } : {}) })
  } catch (err) {
    result = { outcome: 'unknown', httpStatus: null, message: String(err?.message ?? err) }
  }
  await logPaymentEvent(admin, {
    kind: 'refund',
    orderId,
    attemptId,
    payload: {
      refundId, reason, grosze, txn, ...(source ? { source } : {}),
      outcome: result.outcome, httpStatus: result.httpStatus, message: result.message,
    },
  })
  let settled = null
  try {
    const { data, error } = await admin.rpc('settle_refund', { p_refund_id: refundId, p_outcome: SETTLED.has(result.outcome) ? result.outcome : 'unknown' })
    if (error) throw error
    settled = data
  } catch (err) {
    console.error('settle_refund failed:', err?.message)
    await raiseAlert(admin, 'refund_settle_failed', orderId, { refundId, outcome: result.outcome })
  }
  // 'already_settled': a final state (accepted / rejected) was recorded by someone else; the
  // follow-up belongs to them.
  if (settled === 'already_settled') return result.outcome
  if (result.outcome === 'accepted') {
    await sendRefundNotice(admin, orderId, grosze, reason === 'double_payment' ? 'double' : (reason ?? 'late'))
  } else if (result.outcome !== 'insufficient_balance') {
    await raiseAlert(admin, `refund_${result.outcome}`, orderId, {
      refundId, txn, grosze, reason, httpStatus: result.httpStatus,
    })
  }
  return result.outcome
}

// dpay statuses meaning the money arrived (the official SDK's isPaid reads both).
const DPAY_PAID = new Set(['paid', 'captured'])

// A dpay 'created' transaction this old can no longer be paid (PBL lives at most 15 minutes,
// BLIK about 2): it counts as a definitive "not paid".
const DEAD_CREATED_MS = 30 * 60_000

/**
 * Asks dpay about an order's unpaid attempts and confirms a paid one through confirm_order,
 * exactly as an IPN would (source 'poll'; confirm_order is idempotent per attempt), then
 * settleConfirmOutcome. Fail closed: an unrecognised status or amount never confirms.
 * `attempts`: [{ id, dpay_transaction_id, created_at }].
 * → { failed: dpay or RPC failures, settled: true only when EVERY attempt got a definitive
 *     non-paid answer ('expired', or 'created' older than DEAD_CREATED_MS) }. 'processing', a
 *     paid status, an unknown status or a failure leave settled false (Task 7 review I2: the
 *     „Zgłoszenie wygasło” notice needs that proof). Never throws.
 */
export async function checkAttemptsAtDpay(admin, cfg, orderId, attempts) {
  let failed = 0
  let settled = attempts.length > 0
  for (const a of attempts) {
    let details
    try {
      details = await transactionDetails(cfg, a.dpay_transaction_id)
    } catch (err) {
      failed++
      settled = false
      await logPaymentEvent(admin, {
        kind: 'status_check', orderId, attemptId: a.id,
        payload: { txn: a.dpay_transaction_id, ok: false, httpStatus: err?.httpStatus ?? null, message: err?.message ?? null, source: 'job' },
      })
      continue
    }
    await logPaymentEvent(admin, {
      kind: 'status_check', orderId, attemptId: a.id,
      payload: { txn: a.dpay_transaction_id, status: details.status, grosze: details.grosze, raw: details.raw, source: 'job' },
    })
    const age = Date.now() - Date.parse(a.created_at ?? 0)
    const dead = details.status === 'expired' || (details.status === 'created' && age >= DEAD_CREATED_MS)
    if (!dead) settled = false
    if (!DPAY_PAID.has(details.status) || !Number.isSafeInteger(details.grosze)) continue
    const { data: outcome, error } = await admin.rpc('confirm_order', {
      p_order_id: orderId, p_txn: a.dpay_transaction_id, p_grosze: details.grosze, p_source: 'poll',
    })
    if (error) {
      failed++
      console.error('confirm_order (job) failed:', error.message)
      continue
    }
    await settleConfirmOutcome(admin, cfg, { ...outcome, orderId, txn: a.dpay_transaction_id })
  }
  return { failed, settled }
}
