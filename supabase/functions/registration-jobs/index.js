import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { dpayConfig } from '../_shared/dpay.js'
import { sendEmail } from '../_shared/email.js'
import { json, NOT_FOUND } from '../_shared/registration/registrationRequest.js'
import { operatorAlertEmail, orderExpiredEmail, paymentReminderEmail } from '../_shared/registration/emails.js'
import {
  checkAttemptsAtDpay, executeRefund, loadOrderView, orderEmailArgs, raiseAlert, sendOrderConfirmation,
} from '../_shared/registration/orderFlow.js'

// The payment window jobs (plan 3, task 7). pg_cron POSTs here every 15 minutes through pg_net
// (job `registration-jobs`) with the header x-jobs-secret = REGISTRATION_JOBS_SECRET; anything
// else gets 404, as if the function did not exist. Order expiry itself is SQL (expire_orders and
// release_orphan_orders, every 5 minutes); this does what needs dpay or e-mail:
//
//   1. dpay check (Task 5 review M6): an order about to expire, or expired and not yet told, that
//      holds an unpaid dpay transaction is checked at dpay first. A payment whose IPN never
//      reached us is confirmed through confirm_order (late if the order already expired), never
//      met with „Zgłoszenie wygasło”. Each order is checked at most once per CHECK_GAP.
//   2. reminders: a pending order with a window of 6 h or more past its half
//   3. „Zgłoszenie wygasło” for expired orders (not one whose late payment was refunded, and not
//      one whose dpay check failed in this run: the next run retries it)
//   4. lost confirmations (P3-R10): a paid order with no confirmation_sent_at 10 min after payment
//   5. refund retries: insufficient_balance (406) only, an hour apart, 24 at most
//   6. never-sent refunds (P3-R10): an automatic refund with no requested_at 10 min after it was
//      recorded → one refund_never_sent alert (deduplicated), never a send
//   7. the operator digest of every alert not e-mailed yet, alerts from this run included
//
// Every item is claimed before it is acted on (claim_* RPCs: one UPDATE … WHERE <stamp> IS NULL
// over rows locked SKIP LOCKED), so overlapping runs never send the same thing twice. Claim-then-
// send is at-most-once: a runner e-mail that fails after its claim is alerted, never resent.
// The operator digest is the exception: on a failure its claim is given back, because a second
// digest costs nothing and a lost one hides a problem.
// → 200 { data: { checked, confirmed, reminders, expiredNotices, confirmationsResent,
//   refundRetries, refundsNeverSent, alertsEmailed } }

const LIMIT = { check: 50, reminders: 100, notices: 100, confirmations: 50, retries: 20, neverSent: 100, alerts: 200 }
const CHECK_AHEAD_MS = 20 * 60_000 // a run every 15 min sees each order at least once before expiry
const CHECK_BEHIND_MS = 2 * 3_600_000 // after this an expired order is told without a dpay check
const CHECK_GAP_MS = 10 * 60_000
const ATTEMPT_AGE_MS = 15_000 // as order-status: dpay's IPN normally lands first
const NEVER_SENT_MS = 10 * 60_000
const MAX_RETRIES = 24

const encoder = new TextEncoder()
async function sameSecret(given, expected) {
  const [a, b] = await Promise.all([given, expected].map((s) => crypto.subtle.digest('SHA-256', encoder.encode(s))))
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

const iso = (ms) => new Date(ms).toISOString()

async function rpcRows(admin, fn, args) {
  const { data, error } = await admin.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data ?? []
}

// 1. → { checked, confirmed, failedIds }
async function checkAtDpay(admin, cfg) {
  const now = Date.now()
  const gapSince = now - CHECK_GAP_MS
  // Least recently checked first, so a run never keeps re-reading the same rows.
  const { data: orders, error } = await admin.from('orders').select('id, last_status_check_at')
    .or(`and(status.eq.pending,expires_at.lte.${iso(now + CHECK_AHEAD_MS)}),` +
        `and(status.eq.expired,expired_notified_at.is.null,expires_at.gt.${iso(now - CHECK_BEHIND_MS)})`)
    .order('last_status_check_at', { ascending: true, nullsFirst: true })
    .order('expires_at', { ascending: true })
    .limit(LIMIT.check * 4)
  if (error) throw error
  const ids = (orders ?? [])
    .filter((o) => !o.last_status_check_at || Date.parse(o.last_status_check_at) < gapSince)
    .map((o) => o.id)
  if (!ids.length) return { checked: 0, confirmed: 0, failedIds: [] }

  const { data: attempts, error: aErr } = await admin.from('payment_attempts')
    .select('id, order_id, dpay_transaction_id').in('order_id', ids).eq('status', 'created')
    .lt('created_at', iso(now - ATTEMPT_AGE_MS)).order('created_at', { ascending: false })
  if (aErr) throw aErr
  const byOrder = new Map()
  for (const a of attempts ?? []) {
    if (!byOrder.has(a.order_id)) byOrder.set(a.order_id, [])
    byOrder.get(a.order_id).push(a)
  }
  const candidates = ids.filter((id) => byOrder.has(id)).slice(0, LIMIT.check)
  if (!candidates.length) return { checked: 0, confirmed: 0, failedIds: [] }

  // The claim: of overlapping runs (and order-status's own poll) one asks dpay per CHECK_GAP.
  const { data: claimed, error: cErr } = await admin.from('orders')
    .update({ last_status_check_at: new Date().toISOString() })
    .in('id', candidates)
    .or(`last_status_check_at.is.null,last_status_check_at.lt.${iso(now - CHECK_GAP_MS)}`)
    .select('id')
  if (cErr) throw cErr

  let confirmed = 0
  const failedIds = []
  for (const { id } of claimed ?? []) {
    const { failed } = await checkAttemptsAtDpay(admin, cfg, id, byOrder.get(id).slice(0, 3))
    if (failed) failedIds.push(id)
    const { data: o } = await admin.from('orders').select('status').eq('id', id).maybeSingle()
    if (o?.status === 'paid') confirmed++
  }
  return { checked: claimed?.length ?? 0, confirmed, failedIds }
}

// One runner e-mail for a claimed order. A failure is alerted, never resent.
async function mailClaimed(admin, orderId, kind, build) {
  try {
    const view = await loadOrderView(admin, orderId)
    if (!view?.order.buyer_email) return false
    const res = await sendEmail({ to: view.order.buyer_email, ...build(orderEmailArgs(view)) })
    if (res && res.ok === false) throw new Error(`e-mail not accepted (${res.status})`)
    return true
  } catch (err) {
    console.error(`registration-jobs: ${kind} e-mail failed:`, err?.message)
    await raiseAlert(admin, 'email_failed', orderId, { template: kind, error: String(err?.message ?? err) })
    return false
  }
}

const orderUrl = (site, id) => `${site}/zamowienie/${encodeURIComponent(id)}`
const eventUrl = (site, slug) => (slug ? `${site}/events/${encodeURIComponent(slug)}` : site)

async function eachLimited(items, fn, width = 5) {
  for (let i = 0; i < items.length; i += width) await Promise.all(items.slice(i, i + width).map(fn))
}

async function runJobs(admin, cfg, { site, alertTo }) {
  const counts = {
    checked: 0, confirmed: 0, reminders: 0, expiredNotices: 0, confirmationsResent: 0,
    refundRetries: 0, refundsNeverSent: 0, alertsEmailed: 0,
  }

  // 1. dpay before „wygasło”
  let skip = []
  try {
    const r = await checkAtDpay(admin, cfg)
    counts.checked = r.checked
    counts.confirmed = r.confirmed
    skip = r.failedIds
  } catch (err) {
    console.error('registration-jobs: dpay check failed:', err?.message)
    await raiseAlert(admin, 'jobs_step_failed', null, { step: 'dpay_check', error: String(err?.message ?? err) })
  }

  const steps = [
    ['reminders', async () => {
      const ids = await rpcRows(admin, 'claim_payment_reminders', { p_limit: LIMIT.reminders })
      await eachLimited(ids, (id) => mailClaimed(admin, id, 'reminder',
        (a) => paymentReminderEmail({ event: a.event, order: a.order, payUrl: orderUrl(site, id) })))
      counts.reminders = ids.length
    }],
    ['expired_notices', async () => {
      const ids = await rpcRows(admin, 'claim_expired_notices', { p_skip: skip, p_limit: LIMIT.notices })
      await eachLimited(ids, (id) => mailClaimed(admin, id, 'expired',
        (a) => orderExpiredEmail({ event: a.event, order: a.order, eventUrl: eventUrl(site, a.event.slug) })))
      counts.expiredNotices = ids.length
    }],
    ['confirmations', async () => {
      const ids = await rpcRows(admin, 'claim_confirmation_resends', { p_limit: LIMIT.confirmations })
      await eachLimited(ids, (id) => sendOrderConfirmation(admin, id, { claimed: true }))
      counts.confirmationsResent = ids.length
    }],
    ['refund_retries', async () => {
      const due = await rpcRows(admin, 'claim_refund_retries', { p_limit: LIMIT.retries })
      for (const r of due) {
        const outcome = await executeRefund(admin, cfg, {
          orderId: r.order_id, txn: r.txn, refundId: r.refund_id, messageId: r.message_id, attemptId: r.attempt_id,
          grosze: r.amount, reason: r.reason, partial: r.amount < r.attempt_grosze, source: 'retry',
        })
        if (outcome === 'insufficient_balance' && r.attempts >= MAX_RETRIES) {
          await raiseAlert(admin, 'refund_retry_exhausted', r.order_id,
            { refundId: r.refund_id, txn: r.txn, grosze: r.amount, attempts: r.attempts },
            { dedupeKey: `refund_retry_exhausted:${r.refund_id}` })
        }
      }
      counts.refundRetries = due.length
    }],
    ['never_sent', async () => {
      const { data, error } = await admin.from('refunds').select('id, order_id, payment_attempt_id, amount, reason, created_at')
        .eq('kind', 'automatic').is('requested_at', null).lt('created_at', iso(Date.now() - NEVER_SENT_MS))
        .order('created_at').limit(LIMIT.neverSent)
      if (error) throw error
      for (const f of data ?? []) {
        await raiseAlert(admin, 'refund_never_sent', f.order_id,
          { refundId: f.id, attemptId: f.payment_attempt_id, grosze: f.amount, reason: f.reason, recordedAt: f.created_at },
          { dedupeKey: `refund_never_sent:${f.id}` })
      }
      counts.refundsNeverSent = data?.length ?? 0
    }],
    ['alerts', async () => {
      const alerts = await rpcRows(admin, 'claim_operator_alerts', { p_limit: LIMIT.alerts })
      if (!alerts.length) return
      let ok = false
      try {
        const res = await sendEmail({
          to: alertTo,
          ...operatorAlertEmail({
            alerts: alerts.map((a) => ({ kind: a.kind, orderId: a.order_id, payload: a.payload, createdAt: a.created_at })),
          }),
        })
        ok = !(res && res.ok === false)
      } catch (err) {
        console.error('registration-jobs: operator digest failed:', err?.message)
      }
      if (!ok) {
        const { error } = await admin.from('operator_alerts').update({ emailed_at: null }).in('id', alerts.map((a) => a.id))
        if (error) console.error('registration-jobs: alert claim not released:', error.message)
        return
      }
      counts.alertsEmailed = alerts.length
    }],
  ]
  for (const [name, step] of steps) {
    try {
      await step()
    } catch (err) {
      console.error(`registration-jobs: ${name} failed:`, err?.message)
      if (name !== 'alerts') {
        await raiseAlert(admin, 'jobs_step_failed', null, { step: name, error: String(err?.message ?? err) })
      }
    }
  }
  return counts
}

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const secret = Deno.env.get('REGISTRATION_JOBS_SECRET')
  if (!secret) {
    console.error('registration-jobs: REGISTRATION_JOBS_SECRET is not set')
    return json({ error: 'Service unavailable' }, 503, req)
  }
  if (req.method !== 'POST' || !(await sameSecret(req.headers.get('x-jobs-secret') ?? '', secret))) {
    return json(NOT_FOUND, 404, req)
  }

  let cfg
  try {
    cfg = dpayConfig(Deno.env)
  } catch (err) {
    console.error('registration-jobs:', err?.message)
    return json({ error: 'Service unavailable' }, 503, req)
  }
  const alertTo = Deno.env.get('PIPELINE_ALERT_EMAIL')
  if (!alertTo) {
    console.error('registration-jobs: PIPELINE_ALERT_EMAIL is not set')
    return json({ error: 'Service unavailable' }, 503, req)
  }
  const site = cfg.publicSiteUrl ?? Deno.env.get('PUBLIC_SITE_URL')
  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  try {
    const data = await runJobs(admin, cfg, { site: String(site).replace(/\/+$/, ''), alertTo })
    return json({ data }, 200, req)
  } catch (err) {
    console.error('registration-jobs error:', err?.message)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
