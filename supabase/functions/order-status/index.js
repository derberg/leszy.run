import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { dpayConfig, transactionDetails } from '../_shared/dpay.js'
import { isUuid } from '../_shared/registration/organizerEvent.js'
import { json, NOT_FOUND } from '../_shared/registration/registrationRequest.js'
import { loadOrderView, logPaymentEvent, orderAmountsOf, settleConfirmOutcome } from '../_shared/registration/orderFlow.js'

// The poll fallback for a missing IPN: only attempts older than this are asked about (dpay's
// IPN normally lands first), at most this many, and at most once per order per CHECK_GAP_MS.
const ATTEMPT_AGE_MS = 15_000
const CHECK_GAP_MS = 10_000
const MAX_CHECKS = 3
// dpay statuses meaning the money arrived (the official SDK's isPaid reads both).
const PAID = new Set(['paid', 'captured'])

// Asks dpay about the newest unpaid attempts and confirms a paid one, exactly as an IPN
// would (confirm_order is idempotent per attempt, so a late IPN for the same transaction
// gets already_confirmed). The claim is one UPDATE: of two concurrent calls only one polls.
async function poll(admin, req, orderId) {
  const cutoff = new Date(Date.now() - ATTEMPT_AGE_MS).toISOString()
  const { data: attempts, error } = await admin.from('payment_attempts')
    .select('id, dpay_transaction_id, created_at').eq('order_id', orderId).eq('status', 'created')
    .lt('created_at', cutoff).order('created_at', { ascending: false }).limit(MAX_CHECKS)
  if (error) throw error
  if (!attempts?.length) return

  const since = new Date(Date.now() - CHECK_GAP_MS).toISOString()
  const { data: claimed, error: cErr } = await admin.from('orders')
    .update({ last_status_check_at: new Date().toISOString() })
    .eq('id', orderId).eq('status', 'pending')
    .or(`last_status_check_at.is.null,last_status_check_at.lt.${since}`)
    .select('id')
  if (cErr) throw cErr
  if (!claimed?.length) return

  let cfg
  try {
    cfg = dpayConfig(Deno.env)
  } catch (err) {
    console.error('order-status:', err?.message)
    return
  }

  for (const a of attempts) {
    let details
    try {
      details = await transactionDetails(cfg, a.dpay_transaction_id)
    } catch (err) {
      await logPaymentEvent(admin, {
        kind: 'status_check', orderId, attemptId: a.id,
        payload: { txn: a.dpay_transaction_id, ok: false, httpStatus: err?.httpStatus ?? null, message: err?.message ?? null },
      })
      continue
    }
    await logPaymentEvent(admin, {
      kind: 'status_check', orderId, attemptId: a.id,
      payload: { txn: a.dpay_transaction_id, status: details.status, grosze: details.grosze, raw: details.raw },
    })
    // Fail closed: an unrecognised status or amount never confirms.
    if (!PAID.has(details.status) || !Number.isSafeInteger(details.grosze)) continue
    const { data: outcome, error: rpcErr } = await admin.rpc('confirm_order', {
      p_order_id: orderId, p_txn: a.dpay_transaction_id, p_grosze: details.grosze, p_source: 'poll',
    })
    if (rpcErr) {
      console.error('order-status: confirm_order failed:', rpcErr.message)
      continue
    }
    await settleConfirmOutcome(admin, cfg, { ...outcome, orderId, txn: a.dpay_transaction_id })
  }
}

// POST { orderId } → 200 { data: { status, expiresAt, lines: [{ name, competition, ageGroupLabel,
//   startTime, amount }], amounts, event: { slug, name } } }
// The order page's state, for the buyer only (401 without a session, 404 otherwise). While the
// order is pending and dpay may have taken the money without an IPN reaching us, it asks dpay
// (see poll) before answering.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  try {
    const session = await getSession(req, admin)
    if (!session) return json({ error: 'Authorization required' }, 401, req)
    const orderId = body?.orderId
    if (!isUuid(orderId)) return json(NOT_FOUND, 404, req)

    const { data: head, error } = await admin.from('orders')
      .select('id, buyer_profile_id, status').eq('id', orderId).maybeSingle()
    if (error) throw error
    if (!head || head.buyer_profile_id !== session.userId) return json(NOT_FOUND, 404, req)

    if (head.status === 'pending') {
      try {
        await poll(admin, req, orderId)
      } catch (err) {
        console.error('order-status: poll failed:', err?.message)
      }
    }

    const view = await loadOrderView(admin, orderId)
    return json({
      data: {
        status: view.order.status,
        expiresAt: view.order.expires_at,
        lines: view.lines.map((l) => ({
          name: [l.firstName, l.lastName].filter(Boolean).join(' '),
          competition: l.competition,
          ageGroupLabel: l.ageGroupLabel,
          startTime: l.startTime,
          amount: l.amount,
        })),
        amounts: orderAmountsOf(view.order),
        event: { slug: view.settings?.slug ?? null, name: view.settings?.name ?? null },
      },
    }, 200, req)
  } catch (err) {
    console.error('order-status error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
