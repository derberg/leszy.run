import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { checkAndIncrement } from '../_shared/throttle.js'
import { dpayConfig } from '../_shared/dpay.js'
import { isUuid } from '../_shared/registration/organizerEvent.js'
import { json, NOT_FOUND, REFUSALS } from '../_shared/registration/registrationRequest.js'
import { DPAY_DOWN, PAYMENTS_OFF, startPaymentAttempt } from '../_shared/registration/orderFlow.js'

// New payments per order, per hour (claim_throttle_slot).
const PAY_LIMIT = 10
const HOUR = 3600

const EXPIRED = [409, 'Zgłoszenie wygasło. Zapisz się ponownie.']
const STATE_REFUSALS = {
  paid: [409, 'To zgłoszenie jest już opłacone.'],
  cancelled: [409, 'To zgłoszenie zostało anulowane. Zapisz się ponownie.'],
  expired: EXPIRED,
}

// POST { orderId } → 200 { data: { redirectUrl } }
// A new dpay transaction for a pending order at its frozen total (a dpay transaction lives
// minutes, the payment window hours to days, so one order may hold many attempts; ruling 1).
// The buyer only: 401 without a session, 404 for anybody else's order or an unknown one.
// 409 expired / paid / cancelled; 409 „Zapisy są zamknięte.” once registration has closed
// (no new payment after closes_at); 409 full when the paid entries fill the competition (P3-R15); 502 when dpay does not register the transaction.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  let cfg
  try {
    cfg = dpayConfig(Deno.env)
  } catch (err) {
    console.error('pay-order:', err?.message)
    return json({ error: PAYMENTS_OFF }, 503, req)
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

    // P3-R15: paid entries may have filled the competition since the order was made. Only
    // for the payer (no money moves into a full competition); confirm_order's claim decides.
    const { data: fits, error: fitErr } = await admin.rpc('registration_order_fits', { p_order_id: order.id })
    if (fitErr) throw fitErr
    if (fits === false) return refuse(REFUSALS.full, 'full')

    const throttle = await checkAndIncrement(admin, `pay:${order.id}`, PAY_LIMIT, { failOpen: true, windowSeconds: HOUR })
    if (!throttle.allowed) {
      return json({ error: 'Zbyt wiele prób. Spróbuj ponownie później.' }, 429, req,
        { 'retry-after': String(throttle.retryAfterSec) })
    }

    // add_payment_attempt re-checks under the order lock: still pending, not past expiry,
    // registration open. A failure leaves the order pending: it keeps its window (D5-24).
    const attempt = await startPaymentAttempt(admin, cfg, { orderId: order.id, total: order.total })
    if (attempt.redirectUrl) return json({ data: { redirectUrl: attempt.redirectUrl } }, 200, req)
    if (attempt.refused === 'dpay_unavailable') return json({ error: DPAY_DOWN, code: 'dpay_unavailable' }, 502, req)
    if (attempt.refused === 'full') return refuse(REFUSALS.full, 'full')
    const { data: now } = await admin.from('orders').select('status').eq('id', order.id).maybeSingle()
    return now?.status === 'pending' ? refuse(REFUSALS.closed, 'closed') : refuse(STATE_REFUSALS[now?.status] ?? EXPIRED, now?.status ?? 'expired')
  } catch (err) {
    console.error('pay-order error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
