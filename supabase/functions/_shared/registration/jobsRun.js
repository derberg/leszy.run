// The payment window jobs (plan 3, task 7), run by the registration-jobs edge function
// (supabase/functions/registration-jobs/index.js); here so a Node test can run them with or
// without dpay settings.
import { dpayConfig } from '../dpay.js'
import { sendEmail } from '../email.js'
import { operatorAlertEmail, orderExpiredEmail, paymentReminderEmail } from './emails.js'
import {
  checkAttemptsAtDpay, executeRefund, loadOrderView, orderEmailArgs, raiseAlert, sendOrderConfirmation,
} from './orderFlow.js'
import { issueConsentRequestsReport, rotateAndSend } from './consentRequests.js'

// The payment window jobs (plan 3, task 7). pg_cron POSTs here every 15 minutes through pg_net
// (job `registration-jobs`) with the header x-jobs-secret = REGISTRATION_JOBS_SECRET; anything
// else gets 404, as if the function did not exist (also when the secret is not configured).
// Order expiry itself is SQL (expire_orders and release_orphan_orders, every 5 minutes); this does
// what needs dpay or e-mail.
//
// A run has a time budget (BUDGET_MS, 90 s, under pg_net's 120 s timeout and the edge runtime's
// wall clock). Steps run cheapest and most critical first, each checks what is left, and whatever
// does not fit is left for the next run (its rows stay unclaimed):
//   1. the operator digest: every alert not e-mailed yet
//   2. stalled refunds (P3-R10, review I1): never sent, or sent and never answered → one alert
//      each (deduplicated), never a send
//   3. refund retries: insufficient_balance (406) only, an hour apart, 24 at most
//   4. reminders: a pending order with a window of 6 h or more past its half
//   5. dpay check (Task 5 review M6, review I2): an order about to expire, or expired less than
//      2 h ago and not told yet, that holds an unpaid dpay transaction is checked at dpay. A
//      payment whose IPN never reached us is confirmed through confirm_order (late if the order
//      already expired). Only a definitive "not paid" for every attempt stamps dpay_checked_at,
//      the proof step 6 needs. Bounded: 5 at a time, its own deadline, a timeout per call.
//   6. „Zgłoszenie wygasło” (skipped for the run when step 5 failed): claim_expired_notices only
//      hands out orders with that proof, with no unpaid transaction, or expired over 2 h ago
//   7. lost confirmations (P3-R10): a paid order with no confirmation_sent_at 10 min after payment
//   8. consent requests (plan 4, D4-24; no dpay, so it runs under P3-R16):
//      a. a confirmed adult awaiting consent with no request (the function died after the commit)
//         is issued one (issueConsentRequests: issue_consent_request is the claim, so idempotent).
//         Oldest first; a row that cannot be issued is counted (consent_issue_failed), alerted
//         once at its 3rd failure (consent_issue_failed, deduplicated per registration), and from
//         then on swept after every other row, so it cannot starve newer ones;
//      b. a request whose first e-mail never went out (emailed_at NULL, issued 10+ min ago) gets
//         its link re-sent once (claim_consent_resends, a new token);
//      c. the automatic reminder 72 h before closes_at (claim_consent_reminders, once per request,
//         never within 24 h of the last e-mail), „Przypomnienie: …” with a rotated token.
//      A failed send is alerted and never retried by the same sub-step (claim-then-send). The
//      step needs CONSENT_STEP_MS to start, and each sub-step starts (claims) only with
//      CONSENT_PART_MS left, so a claim is never made that the run has no time to send; what
//      does not fit waits, unclaimed, for the next run. Its counts are e-mails sent, not claims.
//   9. the operator digest again, for the alerts this run raised
// A finished run stamps registration_job_heartbeats ('registration-jobs'); the
// registration-watchdog function (hourly, P3-R18) alerts when that stamp is older than 3 runs.
//
// Every runner-facing item is claimed before it is acted on (claim_* RPCs: one UPDATE … WHERE
// <stamp> IS NULL over rows locked SKIP LOCKED), so overlapping runs never send the same thing
// twice. Claim-then-send is at-most-once: a runner e-mail that fails after its claim is alerted,
// never resent. The operator digest is the opposite: alerts are marked e-mailed only after the
// digest went out, so a crash or a failure sends them again next time (a second digest is cheap,
// a lost one hides a problem).
// Without dpay settings (P3-R16: paid registration not switched on, no production dpay
// secrets yet) steps 3 and 5 are skipped and reported in `skipped` as dpay_not_configured, with
// no alert; everything else runs and the heartbeat is still stamped.
// POST body: {} from cron; { budgetMs } may only shorten the budget (tests).
// → 200 { data: { checked, confirmed, reminders, expiredNotices, confirmationsResent,
//   refundRetries, stalledRefunds, consentRequestsIssued, consentEmailsResent, consentReminders,
//   alertsEmailed, deferred: [step…], skipped: { step: reason } } }

const BUDGET_MS = 90_000
const MIN_BUDGET_MS = 5_000
const LIMIT = { check: 50, reminders: 100, notices: 100, confirmations: 50, retries: 20, stalled: 100, alerts: 200, consent: 50 }
const CHECK_AHEAD_MS = 20 * 60_000 // a run every 15 min sees each order at least once before expiry
const CHECK_BEHIND_MS = 2 * 3_600_000 // after this an expired order is told without a dpay check
const CHECK_GAP_MS = 10 * 60_000
const ATTEMPT_AGE_MS = 15_000 // as order-status: dpay's IPN normally lands first
const CHECK_WIDTH = 5
const DPAY_CALL_MS = 8_000
// dpay calls per order and run. An order holding more unpaid attempts is checked on its newest
// ones but never gets the proof stamp (re-review I2-a): it falls back to the 2 h cutoff.
const MAX_ATTEMPTS_CHECKED = 3
const MAX_RETRIES = 24
// Share of the budget after which a step that calls dpay starts nothing new.
const RETRY_SHARE = 0.3
const CHECK_SHARE = 0.6

export const DPAY_NOT_CONFIGURED = 'dpay_not_configured'
// The steps that call dpay: skipped without its settings.
export const DPAY_STEPS = ['refund_retries', 'dpay_check']
const DEFAULT_SITE = 'https://www.leszy.run'
// Step 8 claims up to LIMIT.consent rows three times and sends 5 at a time: up to 30 rounds of
// e-mail, about 1 s each through SendGrid.
const CONSENT_STEP_MS = 15_000
const CONSENT_PART_MS = 10_000
// The run at which a missing request that keeps failing is alerted (m7).
const CONSENT_ISSUE_ALERT_AT = 3

/**
 * What a run needs from the environment (Deno.env, or anything with get(), or a plain object).
 * → { cfg, dpayMissing, site, alertTo } or { error } when PIPELINE_ALERT_EMAIL is missing (an alert
 * nobody receives is worse than a run that refuses). Missing or broken dpay settings are not an
 * error: cfg is null and the dpay steps are skipped (P3-R16).
 */
export function jobsSettings(env) {
  const read = (k) => (typeof env?.get === 'function' ? env.get(k) : env?.[k])
  const alertTo = read('PIPELINE_ALERT_EMAIL')?.trim()
  if (!alertTo) return { error: 'PIPELINE_ALERT_EMAIL is not set' }
  let cfg = null
  try { cfg = dpayConfig(env) } catch { /* not configured: the dpay steps are skipped */ }
  const site = (cfg?.publicSiteUrl ?? read('PUBLIC_SITE_URL')?.trim() ?? DEFAULT_SITE).replace(/\/+$/, '') || DEFAULT_SITE
  return { cfg, dpayMissing: !cfg, site, alertTo }
}

/** One run, then the heartbeat the registration-watchdog function reads (P3-R11, P3-R18). */
export async function runJobsAndBeat(admin, { cfg, site, alertTo }, { budgetMs } = {}) {
  const asked = Number(budgetMs)
  const budget = Number.isFinite(asked) ? Math.max(MIN_BUDGET_MS, Math.min(BUDGET_MS, asked)) : BUDGET_MS
  const data = await runJobs(admin, cfg, { site, alertTo, budgetMs: budget })
  // A failed step still stamps; it raised its own alert. A failed stamp is logged and never
  // fails the run.
  const { error: beatErr } = await admin.rpc('registration_job_heartbeat', { p_job: 'registration-jobs' })
  if (beatErr) console.error('registration-jobs: heartbeat not stamped:', beatErr.message)
  return data
}

const iso = (ms) => new Date(ms).toISOString()

async function rpcRows(admin, fn, args) {
  const { data, error } = await admin.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data ?? []
}

function clock(budgetMs) {
  const start = Date.now()
  return {
    left: () => start + budgetMs - Date.now(),
    until: (share) => start + budgetMs * share - Date.now(),
  }
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

// One consent link for a claimed request (rotateAndSend). A request accepted or signed in the
// office meanwhile gets nothing; a failure is alerted, never resent by this claim.
async function consentMail(admin, registrationId, { reminder, site, template }) {
  try {
    const outcome = await rotateAndSend(admin, registrationId, { reminder, site })
    if (outcome !== 'failed') return outcome === 'sent'
    await raiseAlert(admin, 'email_failed', null, { template, registrationId })
  } catch (err) {
    console.error(`registration-jobs: ${template} failed:`, err?.message)
    await raiseAlert(admin, 'email_failed', null, { template, registrationId, error: String(err?.message ?? err) })
  }
  return false
}

// Step 8a: one more failed attempt at issuing a missing request. The 3rd is alerted, once
// (deduplicated per registration); a count that cannot be stored is logged and never fails the step.
async function countIssueFailure(admin, registrationId) {
  const { data: failures, error } = await admin.rpc('consent_issue_failed', { p_registration_id: registrationId })
  if (error) {
    console.error(`registration-jobs: consent issue failure of ${registrationId} not counted:`, error.message)
    return
  }
  if (failures >= CONSENT_ISSUE_ALERT_AT) {
    await raiseAlert(admin, 'consent_issue_failed', null, { registrationId, failures },
      { dedupeKey: `consent_issue_failed:${registrationId}` })
  }
}

async function eachLimited(items, fn, width = 5) {
  for (let i = 0; i < items.length; i += width) await Promise.all(items.slice(i, i + width).map(fn))
}

// Steps 1 and 8. Marks only what went out.
async function digest(admin, alertTo) {
  const { data: alerts, error } = await admin.from('operator_alerts')
    .select('id, kind, order_id, payload, created_at').is('emailed_at', null)
    .order('created_at').limit(LIMIT.alerts)
  if (error) throw error
  if (!alerts?.length) return 0
  const res = await sendEmail({
    to: alertTo,
    ...operatorAlertEmail({
      alerts: alerts.map((a) => ({ kind: a.kind, orderId: a.order_id, payload: a.payload, createdAt: a.created_at })),
    }),
  })
  if (res && res.ok === false) throw new Error(`digest not accepted (${res.status})`)
  const { error: mErr } = await admin.from('operator_alerts').update({ emailed_at: new Date().toISOString() })
    .in('id', alerts.map((a) => a.id)).is('emailed_at', null)
  if (mErr) console.error('registration-jobs: alerts not marked e-mailed:', mErr.message)
  return alerts.length
}

// Step 5. → { checked, confirmed, cut }
async function checkAtDpay(admin, cfg, time) {
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
  if (!ids.length) return { checked: 0, confirmed: 0, cut: false }

  const { data: attempts, error: aErr } = await admin.from('payment_attempts')
    .select('id, order_id, dpay_transaction_id, created_at').in('order_id', ids).eq('status', 'created')
    .lt('created_at', iso(now - ATTEMPT_AGE_MS)).order('created_at', { ascending: false })
  if (aErr) throw aErr
  const byOrder = new Map()
  for (const a of attempts ?? []) {
    if (!byOrder.has(a.order_id)) byOrder.set(a.order_id, [])
    byOrder.get(a.order_id).push(a)
  }
  const queue = ids.filter((id) => byOrder.has(id)).slice(0, LIMIT.check)

  let checked = 0
  let confirmed = 0
  let cut = false
  let aborted = false
  const worker = async () => {
    for (;;) {
      const left = time.until(CHECK_SHARE)
      if (aborted || !queue.length) return
      if (left < DPAY_CALL_MS + 1_000) { cut = true; return }
      const id = queue.shift()
      // The claim: of overlapping runs (and order-status's own poll) one asks dpay per CHECK_GAP.
      const { data: claimed, error: cErr } = await admin.from('orders')
        .update({ last_status_check_at: new Date().toISOString() })
        .eq('id', id)
        .or(`last_status_check_at.is.null,last_status_check_at.lt.${iso(Date.now() - CHECK_GAP_MS)}`)
        .select('id')
      if (cErr) throw cErr
      if (!claimed?.length) continue
      checked++
      const callCfg = { ...cfg, timeoutMs: Math.min(DPAY_CALL_MS, Math.max(1_000, left - 1_000)) }
      const all = byOrder.get(id)
      const { settled } = await checkAttemptsAtDpay(admin, callCfg, id, all.slice(0, MAX_ATTEMPTS_CHECKED))
      const { data: o } = await admin.from('orders').select('status').eq('id', id).maybeSingle()
      if (o?.status === 'paid') confirmed++
      // The proof covers the whole set of unpaid attempts, never just the ones asked about.
      else if (settled && all.length <= MAX_ATTEMPTS_CHECKED) {
        const { error: sErr } = await admin.from('orders').update({ dpay_checked_at: new Date().toISOString() }).eq('id', id)
        if (sErr) throw sErr
      }
    }
  }
  // One worker failing stops the others: the step then counts as failed and skips the notices.
  await Promise.all(Array.from({ length: CHECK_WIDTH }, () => worker().catch((err) => { aborted = true; throw err })))
  return { checked, confirmed, cut: cut || queue.length > 0 }
}

export async function runJobs(admin, cfg, { site, alertTo, budgetMs }) {
  const time = clock(budgetMs)
  const counts = {
    checked: 0, confirmed: 0, reminders: 0, expiredNotices: 0, confirmationsResent: 0,
    refundRetries: 0, stalledRefunds: 0, consentRequestsIssued: 0, consentEmailsResent: 0, consentReminders: 0,
    alertsEmailed: 0, deferred: [], skipped: {},
  }
  const hour = new Date().toISOString().slice(0, 13)
  const budgetAlert = (step) => raiseAlert(admin, 'jobs_step_failed', null,
    { step: `${step}_budget`, budgetMs }, { dedupeKey: `jobs_budget:${step}:${hour}` })
  let checkFailed = false

  const steps = [
    ['digest', 1_000, async () => { counts.alertsEmailed += await digest(admin, alertTo) }],
    ['stalled_refunds', 1_000, async () => {
      const rows = await rpcRows(admin, 'stalled_refunds', { p_limit: LIMIT.stalled })
      for (const f of rows) {
        await raiseAlert(admin, f.alert_kind, f.order_id, {
          refundId: f.refund_id, attemptId: f.attempt_id, grosze: f.amount, reason: f.reason,
          recordedAt: f.created_at, requestedAt: f.requested_at,
        }, { dedupeKey: f.dedupe_key })
      }
      counts.stalledRefunds = rows.length
    }],
    ['refund_retries', DPAY_CALL_MS + 2_000, async () => {
      for (;;) {
        const left = time.until(RETRY_SHARE)
        if (left < DPAY_CALL_MS + 1_000) {
          // Anything still due waits for the next run, unclaimed.
          const { count } = await admin.from('refunds').select('id', { count: 'exact', head: true })
            .eq('dpay_status', 'insufficient_balance').lte('next_retry_at', new Date().toISOString()).lt('attempts', MAX_RETRIES)
          if (count) { counts.deferred.push('refund_retries'); await budgetAlert('refund_retries') }
          return
        }
        const [r] = await rpcRows(admin, 'claim_refund_retries', { p_limit: 1 })
        if (!r) return
        counts.refundRetries++
        const outcome = await executeRefund(admin, { ...cfg, timeoutMs: Math.min(cfg.timeoutMs ?? 10_000, left - 1_000) }, {
          orderId: r.order_id, txn: r.txn, refundId: r.refund_id, messageId: r.message_id, attemptId: r.attempt_id,
          grosze: r.amount, reason: r.reason, partial: r.amount < r.attempt_grosze, source: 'retry',
        })
        if (outcome === 'insufficient_balance' && r.attempts >= MAX_RETRIES) {
          // Exhausted: no further retry, and the row no longer looks due (review M4).
          await admin.from('refunds').update({ next_retry_at: null }).eq('id', r.refund_id)
          await raiseAlert(admin, 'refund_retry_exhausted', r.order_id,
            { refundId: r.refund_id, txn: r.txn, grosze: r.amount, attempts: r.attempts },
            { dedupeKey: `refund_retry_exhausted:${r.refund_id}` })
        }
      }
    }],
    ['reminders', 2_000, async () => {
      const ids = await rpcRows(admin, 'claim_payment_reminders', { p_limit: LIMIT.reminders })
      await eachLimited(ids, (id) => mailClaimed(admin, id, 'reminder',
        (a) => paymentReminderEmail({ event: a.event, order: a.order, payUrl: `${site}/zamowienie/${encodeURIComponent(id)}` })))
      counts.reminders = ids.length
    }],
    ['dpay_check', DPAY_CALL_MS + 2_000, async () => {
      try {
        const r = await checkAtDpay(admin, cfg, time)
        counts.checked = r.checked
        counts.confirmed = r.confirmed
        if (r.cut) { counts.deferred.push('dpay_check'); await budgetAlert('dpay_check') }
      } catch (err) {
        checkFailed = true
        throw err
      }
    }],
    ['expired_notices', 2_000, async () => {
      if (checkFailed) { counts.deferred.push('expired_notices'); return }
      const ids = await rpcRows(admin, 'claim_expired_notices', { p_limit: LIMIT.notices })
      await eachLimited(ids, (id) => mailClaimed(admin, id, 'expired',
        (a) => orderExpiredEmail({
          event: a.event, order: a.order,
          eventUrl: a.event.slug ? `${site}/events/${encodeURIComponent(a.event.slug)}` : site,
        })))
      counts.expiredNotices = ids.length
    }],
    ['confirmations', 2_000, async () => {
      const ids = await rpcRows(admin, 'claim_confirmation_resends', { p_limit: LIMIT.confirmations })
      await eachLimited(ids, (id) => sendOrderConfirmation(admin, id, { claimed: true }))
      counts.confirmationsResent = ids.length
    }],
    ['consent_reminders', CONSENT_STEP_MS, async () => {
      const fits = () => {
        if (time.left() >= CONSENT_PART_MS) return true
        counts.deferred.push('consent_reminders')
        return false
      }
      const missing = await rpcRows(admin, 'consent_requests_missing', { p_limit: LIMIT.consent })
      if (missing.length) {
        const { sent, failed } = await issueConsentRequestsReport(admin, missing, { site })
        counts.consentRequestsIssued = sent
        for (const id of failed) await countIssueFailure(admin, id)
      }
      if (!fits()) return
      const resends = await rpcRows(admin, 'claim_consent_resends', { p_limit: LIMIT.consent })
      await eachLimited(resends, async (id) => {
        if (await consentMail(admin, id, { reminder: false, site, template: 'consent_resend' })) counts.consentEmailsResent++
      })
      if (!fits()) return
      const due = await rpcRows(admin, 'claim_consent_reminders', { p_limit: LIMIT.consent })
      await eachLimited(due, async (id) => {
        if (await consentMail(admin, id, { reminder: true, site, template: 'consent_reminder' })) counts.consentReminders++
      })
    }],
    ['digest', 1_000, async () => { counts.alertsEmailed += await digest(admin, alertTo) }],
  ]
  for (const [name, needs, step] of steps) {
    if (!cfg && DPAY_STEPS.includes(name)) {
      counts.skipped[name] = DPAY_NOT_CONFIGURED
      continue
    }
    if (time.left() < needs) {
      counts.deferred.push(name)
      continue
    }
    try {
      await step()
    } catch (err) {
      console.error(`registration-jobs: ${name} failed:`, err?.message)
      if (name !== 'digest') {
        await raiseAlert(admin, 'jobs_step_failed', null, { step: name, error: String(err?.message ?? err) },
          { dedupeKey: `jobs_step_failed:${name}:${hour}` })
      }
    }
  }
  return counts
}
