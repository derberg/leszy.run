import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { checkAndIncrement } from '../_shared/throttle.js'
import { dpayConfig, registerTransaction } from '../_shared/dpay.js'
import { isUuid } from '../_shared/registration/organizerEvent.js'
import { json, NOT_FOUND, REFUSALS } from '../_shared/registration/registrationRequest.js'
import { logPaymentEvent } from '../_shared/registration/orderFlow.js'

// New payments per order, per hour (claim_throttle_slot).
const PAY_LIMIT = 10
const HOUR = 3600

const EXPIRED = [409, 'Zgłoszenie wygasło. Zapisz się ponownie.']
const STATE_REFUSALS = {
  paid: [409, 'To zgłoszenie jest już opłacone.'],
  cancelled: [409, 'To zgłoszenie zostało anulowane. Zapisz się ponownie.'],
  expired: EXPIRED,
}
const DPAY_DOWN = 'Nie udało się połączyć z operatorem płatności. Spróbuj ponownie.'

// POST { orderId } → 200 { data: { redirectUrl } }
// A new dpay transaction for a pending order at its frozen total (a dpay transaction lives
// minutes, the payment window hours to days, so one order may hold many attempts; ruling 1).
// The buyer only: 401 without a session, 404 for anybody else's order or an unknown one.
// 409 expired / paid / cancelled; 409 „Zapisy są zamknięte.” once registration has closed
// (no new payment after closes_at); 502 when dpay does not register the transaction.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  let cfg
  try {
    cfg = dpayConfig(Deno.env)
  } catch (err) {
    console.error('pay-order:', err?.message)
    return json({ error: 'Płatności online są chwilowo niedostępne.' }, 503, req)
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  try {
    const session = await getSession(req, admin)
    if (!session) return json({ error: 'Authorization required' }, 401, req)
    const orderId = body?.orderId
    if (!isUuid(orderId)) return json(NOT_FOUND, 404, req)

    const { data: order, error } = await admin.from('orders')
      .select('id, event_id, buyer_profile_id, status, total, expires_at').eq('id', orderId).maybeSingle()
    if (error) throw error
    if (!order || order.buyer_profile_id !== session.userId) return json(NOT_FOUND, 404, req)

    const refuse = ([status, text], code) => json({ error: text, code }, status, req)
    if (STATE_REFUSALS[order.status]) return refuse(STATE_REFUSALS[order.status], order.status)
    if (new Date(order.expires_at) <= new Date()) return refuse(EXPIRED, 'expired')
    const { data: rs, error: rsErr } = await admin.from('registration_settings')
      .select('closes_at').eq('event_id', order.event_id).maybeSingle()
    if (rsErr) throw rsErr
    if (!rs?.closes_at || new Date(rs.closes_at) <= new Date()) return refuse(REFUSALS.closed, 'closed')

    const throttle = await checkAndIncrement(admin, `pay:${order.id}`, PAY_LIMIT, { failOpen: true, windowSeconds: HOUR })
    if (!throttle.allowed) {
      return json({ error: 'Zbyt wiele prób. Spróbuj ponownie później.' }, 429, req,
        { 'retry-after': String(throttle.retryAfterSec) })
    }

    let txn
    try {
      txn = await registerTransaction(cfg, { orderId: order.id, grosze: order.total })
    } catch (err) {
      console.error('pay-order: dpay register failed:', err?.httpStatus ?? null, err?.message)
      await logPaymentEvent(admin, {
        kind: 'register', orderId: order.id,
        payload: { ok: false, httpStatus: err?.httpStatus ?? null, message: err?.message ?? null, grosze: order.total },
      })
      return json({ error: DPAY_DOWN, code: 'dpay_unavailable' }, 502, req)
    }

    // The RPC re-checks under the order lock: still pending, not past expiry, registration open.
    const { data: attemptId, error: aErr } = await admin.rpc('add_payment_attempt', {
      p_order_id: order.id, p_txn: txn.transactionId, p_grosze: order.total,
    })
    if (aErr) {
      if (aErr.message === 'not_payable') {
        const { data: now } = await admin.from('orders').select('status').eq('id', order.id).maybeSingle()
        return now?.status === 'pending' ? refuse(REFUSALS.closed, 'closed') : refuse(STATE_REFUSALS[now?.status] ?? EXPIRED, now?.status ?? 'expired')
      }
      throw aErr
    }
    await logPaymentEvent(admin, {
      kind: 'register', orderId: order.id, attemptId,
      payload: { ok: true, transactionId: txn.transactionId, redirectUrl: txn.redirectUrl, grosze: order.total },
    })
    return json({ data: { redirectUrl: txn.redirectUrl } }, 200, req)
  } catch (err) {
    console.error('pay-order error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
