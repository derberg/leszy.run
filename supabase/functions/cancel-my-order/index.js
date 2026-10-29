import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { checkAndIncrement } from '../_shared/throttle.js'
import { isUuid } from '../_shared/registration/organizerEvent.js'
import { json, NOT_FOUND } from '../_shared/registration/registrationRequest.js'

// Cancels per buyer, per hour (claim_throttle_slot).
const CANCEL_LIMIT = 20
const HOUR = 3600

const REFUSALS = {
  paid: [409, 'To zgłoszenie jest już opłacone.'],
  expired: [409, 'Zgłoszenie wygasło.'],
  cancelled_already: [409, 'Zgłoszenie anulowane.', 'cancelled'],
  payment_received: [409, 'Wpłata za to zgłoszenie już dotarła. Odśwież stronę.'],
}

// POST { orderId } → 200 { data: { status: 'cancelled' } }
// The buyer cancels their own unpaid order (P3-R15 re-review I1): an order whose competition the
// paid entries filled can no longer be paid, and while it is pending its address cannot register
// again (409 pending_order). buyer_cancel_order checks everything under the order lock and calls
// cancel_order(…, 'buyer_cancelled'); it never refunds, because a pending order holds no money,
// and a payment that lands afterwards is refunded in full by confirm_order (late_refund cancelled).
// 401 without a session; 404 for an unknown order or anybody else's; 409 paid / expired /
// cancelled / payment_received (an attempt already paid); 429 past CANCEL_LIMIT an hour.
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

    const throttle = await checkAndIncrement(admin, `cancel-order:${session.userId}`, CANCEL_LIMIT, { failOpen: true, windowSeconds: HOUR })
    if (!throttle.allowed) {
      return json({ error: 'Zbyt wiele prób. Spróbuj ponownie później.' }, 429, req,
        { 'retry-after': String(throttle.retryAfterSec) })
    }

    const orderId = body?.orderId
    if (!isUuid(orderId)) return json(NOT_FOUND, 404, req)

    const { data: outcome, error } = await admin.rpc('buyer_cancel_order', { p_order_id: orderId, p_profile_id: session.userId })
    if (error) throw error
    if (outcome === 'cancelled') return json({ data: { status: 'cancelled' } }, 200, req)
    if (outcome === 'not_found') return json(NOT_FOUND, 404, req)
    const [status, text, code = outcome] = REFUSALS[outcome] ?? [409, 'Nie można anulować tego zgłoszenia.']
    return json({ error: text, code }, status, req)
  } catch (err) {
    console.error('cancel-my-order error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
