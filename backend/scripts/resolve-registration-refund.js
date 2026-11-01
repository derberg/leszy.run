// Usage: cd backend && node --env-file=../.env scripts/resolve-registration-refund.js \
//          --refund <refund id> --outcome accepted|rejected --note "<who decided, on what>" [--apply]
//
// The operator's answer for an organizer refund dpay never answered for certain (Plan 6). Dry run
// by default: it prints the refund, its order line and its order, and changes nothing. With
// --apply it calls resolve_organizer_refund, which applies what dpay's own answer would have:
//   accepted  the money is out; the entry is cancelled once the accepted refunds cover its line,
//             and registration-jobs' refund_emails step sends the club's refund e-mail to the
//             payer and the runner within 15 minutes (claimed on runner_notified_at, once)
//   rejected  the reservation is given back to the line, so the organizer can refund again
// Only a refund still `pending` or `unknown` can be resolved; anything else is refused.
//
// RUNBOOK. Check the dpay panel FIRST: find the transaction this prints, and look at its refunds.
// Never resolve from memory or from the alert alone. A refund is in front of you because of one of
// these operator alerts (the operator digest, [ALERT] Płatności: …):
//   refund_unknown / refund_pending   dpay timed out, answered 5xx or 409. The panel shows the
//                                     refund → --outcome accepted; it does not → --outcome rejected.
//   refund_stalled (reason organizer) the function claimed the refund and never stored an answer.
//                                     Same as above.
//   refund_never_sent (reason organizer) the money was reserved and dpay was never called. The panel
//                                     shows no refund → --outcome rejected (it frees the money).
//   refund_email_failed               the refund is accepted, the club's e-mail did not go out.
//                                     step "claim" or "release" in the payload, or step "send" from
//                                     the job: fix the cause (the address bounced: write to the
//                                     runner by hand), or set refunds.runner_notified_at back to
//                                     NULL so the job sends it on its next run.
//   refund_email_unknown              the sender timed out; the e-mail may have gone. Check the
//                                     SendGrid activity for the order's buyer; only if nothing was
//                                     delivered, set runner_notified_at back to NULL as above.
//   refund_followup_failed            the refund itself is stored. The audit row or the e-mail after
//                                     it failed: if runner_notified_at is NULL the job sends the
//                                     e-mail; nothing about the money needs doing.
//   refund_email_args_failed          the job could not read what the e-mail needs (a database
//                                     error on that refund's line, order or event). It retries every
//                                     run; look at the refunds row and its order_line_id.
//   refund_insufficient_balance (reason organizer) dpay refused for a low balance. Nothing to
//                                     resolve: the reservation was given back, nobody retries it, and
//                                     the organizer can ask again once the dpay balance is topped up.
// The note goes into refunds.resolved_by (500 characters at most): say who looked and what the
// panel showed, e.g. "LG 2026-11-01: panel dpay, zwrot 20,00 zł widoczny".

import { createClient } from '@supabase/supabase-js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OUTCOMES = ['accepted', 'rejected']
const OPEN = ['pending', 'unknown']

// A value that is itself a flag counts as missing: `--note --apply` must not apply with the note
// "--apply" (Task 5 review M2).
function arg(name) {
  const i = process.argv.indexOf(name)
  const value = i === -1 ? undefined : process.argv[i + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

function usage(message) {
  console.error(`${message}\n\nUsage: node --env-file=../.env scripts/resolve-registration-refund.js ` +
    '--refund <id> --outcome accepted|rejected --note "<text>" [--apply]')
  process.exit(2)
}

const apply = process.argv.includes('--apply')
const refundId = arg('--refund')
const outcome = arg('--outcome')
const note = arg('--note')?.trim()

if (!refundId || !UUID_RE.test(refundId)) usage('--refund must be a refund id (uuid)')
if (!OUTCOMES.includes(outcome)) usage('--outcome must be accepted or rejected')
if (!note) usage('--note is required: who decided, and what the dpay panel showed')
if (note.length > 500) usage('--note is longer than 500 characters')

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } })

const pln = (grosze) => `${(grosze / 100).toFixed(2).replace('.', ',')} zł`

async function one(table, columns, id) {
  const { data, error } = await supabase.from(table).select(columns).eq('id', id).maybeSingle()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data
}

function show(title, row) {
  console.log(`\n${title}`)
  for (const [k, v] of Object.entries(row)) console.log(`  ${k.padEnd(20)} ${v ?? '—'}`)
}

try {
  const refund = await one('refunds',
    'id, kind, dpay_status, amount, reason, order_id, order_line_id, payment_attempt_id, message_id, ' +
    'created_at, requested_at, responded_at, runner_notified_at, resolved_by', refundId)
  if (!refund) {
    console.error(`No refund ${refundId}.`)
    process.exit(1)
  }
  const [attempt, line, order] = await Promise.all([
    refund.payment_attempt_id ? one('payment_attempts', 'id, dpay_transaction_id, grosze, status', refund.payment_attempt_id) : null,
    refund.order_line_id ? one('order_lines', 'id, kind, amount, refunded, registration_id', refund.order_line_id) : null,
    one('orders', 'id, status, total, event_id, paid_at', refund.order_id),
  ])
  const registration = line?.registration_id ? await one('registrations', 'id, status, refunded', line.registration_id) : null

  show('Refund', {
    id: refund.id, kind: refund.kind, status: refund.dpay_status, amount: pln(refund.amount), reason: refund.reason,
    created_at: refund.created_at, requested_at: refund.requested_at, responded_at: refund.responded_at,
    message_id: refund.message_id, runner_notified_at: refund.runner_notified_at, resolved_by: refund.resolved_by,
  })
  if (attempt) {
    show('dpay transaction (look it up in the dpay panel)', {
      transaction: attempt.dpay_transaction_id, paid: pln(attempt.grosze), attempt_status: attempt.status,
    })
  }
  if (line) {
    show('Order line', {
      id: line.id, kind: line.kind, amount: pln(line.amount), reserved_or_refunded: pln(line.refunded),
      registration: line.registration_id, registration_status: registration?.status,
    })
  }
  if (order) show('Order', { id: order.id, status: order.status, total: pln(order.total), event: order.event_id, paid_at: order.paid_at })

  if (refund.kind !== 'organizer') {
    console.error(`\nRefused: a ${refund.kind} refund is not resolved here (only an organizer refund is).`)
    process.exit(1)
  }
  if (!OPEN.includes(refund.dpay_status)) {
    console.error(`\nRefused: the refund is already ${refund.dpay_status}; only pending or unknown can be resolved.`)
    process.exit(1)
  }

  console.log(`\nResolution: ${outcome} — "${note}"`)
  if (!apply) {
    console.log('\nDRY RUN — nothing changed. Check the dpay panel, then add --apply.')
    process.exit(0)
  }

  const { data, error } = await supabase.rpc('resolve_organizer_refund', { p_refund_id: refundId, p_outcome: outcome, p_note: note })
  if (error) {
    console.error(`\nresolve_organizer_refund refused: ${error.message}`)
    process.exit(1)
  }
  console.log(`\nResolved: ${data.status}. Cancelled registrations: ${(data.cancelled ?? []).join(', ') || 'none'}.`)
  if (data.hostWithdraw) console.log('The entry was cancelled after closes_at: a host_withdraw alert names the bibs to withdraw on the hosts.')
  if (outcome === 'accepted') console.log('The refund e-mail goes out with the next registration-jobs run (within 15 minutes).')
  process.exit(0)
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
