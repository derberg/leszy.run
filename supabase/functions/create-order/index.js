import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { clientIp } from '../_shared/organizer.js'
import { dpayConfig, registerTransaction } from '../_shared/dpay.js'
import { orderAmounts } from '../_shared/registration/money.js'
import { json, NOT_FOUND, REFUSALS, prepareRegistration } from '../_shared/registration/registrationRequest.js'
import { logPaymentEvent, raiseAlert, sendOrderConfirmation } from '../_shared/registration/orderFlow.js'

// Throttles (claim_throttle_slot): orders per address and per client IP, per hour.
const ORDER_LIMIT = 10
const ORDER_IP_LIMIT = 30
const HOUR = 3600

// create_order's refusals beyond register_free's, and what the runner reads.
const ORDER_REFUSALS = {
  ...REFUSALS,
  free_event: [409, 'Zapisy na te zawody są bezpłatne.'],
  no_price: [409, 'Ta konkurencja nie ma jeszcze ceny. Spróbuj później.'],
  paying_closed: [409, 'Zapisy z płatnością online kończą się godzinę przed zamknięciem zapisów.'],
  too_many_pending: [409, 'Masz już dwa nieopłacone zgłoszenia na te zawody.'],
  support_choice_required: [400, 'Wybierz, czy wspierasz LESZY.RUN.'],
  invalid_buyer_email: [400, 'Popraw adres e-mail.'],
  'invalid_amount:total': [400, 'Kwota zamówienia przekracza limit płatności online.'],
}
const PRICE_CHANGED = 'Cena się zmieniła. Sprawdź podsumowanie.'
const DPAY_DOWN = 'Nie udało się połączyć z operatorem płatności. Spróbuj ponownie.'
const PENDING_ORDER = 'Masz już nieopłacone zgłoszenie na te zawody.'

// The amounts behind a price_changed refusal: the competition's current price from the
// public read model (the same tier choice create_order makes) through money.js. When they
// do not reproduce the RPC's total (the price moved again in between) only the total goes back.
async function currentAmounts(admin, settings, categoryId, people, supportChoice, total) {
  try {
    const { data } = await admin.rpc('registration_raw', { p_event_id: settings.event_id })
    const price = data?.competitions?.find((c) => c.categoryId === categoryId)?.priceGrosze
    if (Number.isSafeInteger(price)) {
      const a = orderAmounts({ entryPrices: Array(people).fill(price), supportChoice })
      if (a.total === total) {
        return { entryTotal: a.entryTotal, extrasTotal: 0, donation: 0, supportFee: a.supportFee, paymentFee: a.paymentFee, total }
      }
    }
  } catch (err) {
    console.error('create-order: amounts for price_changed:', err?.message)
  }
  return { total }
}

// The live registration for this address is in this buyer's own pending order (a resubmit
// after leaving the dpay page, or a double click) → that order's id, else null (P3-R8).
async function ownPendingOrder(admin, eventId, email, profileId) {
  const { data: regs, error } = await admin.from('registrations')
    .select('order_id').eq('event_id', eventId).eq('email', email).eq('status', 'pending_payment')
  if (error) throw error
  const ids = (regs ?? []).map((r) => r.order_id).filter(Boolean)
  if (!ids.length) return null
  const { data: orders, error: oErr } = await admin.from('orders')
    .select('id').in('id', ids).eq('status', 'pending').eq('buyer_profile_id', profileId).limit(1)
  if (oErr) throw oErr
  return orders?.[0]?.id ?? null
}

// POST { categoryId, person, acceptedConsentIds, serviceRegulamin, supportChoice, displayedTotal, code? }
//   → 201 { data: { orderId, redirectUrl } }, or { data: { orderId, status: 'paid' } } when the total is 0.
// register-free's body plus the support choice (a boolean, nothing preselected) and the total the
// page showed, which is only compared with the server's (409 price_changed with the amounts). Every
// check before the RPC is register-free's (prepareRegistration). create_order writes the order (409
// full when the paid entries fill the competition; an unpaid order claims no slot, P3-R15), then dpay
// registers the transaction. An order that leaves this function without a redirect handed out (a dpay
// failure, a refused attempt, any error) is cancelled (P3-R7). A resubmit that finds this buyer's own pending order answers 409
// pending_order with its id (P3-R8). No e-mail goes out before payment.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  const { supportChoice, displayedTotal } = body ?? {}
  if (typeof supportChoice !== 'boolean') {
    return json({ error: ORDER_REFUSALS.support_choice_required[1], code: 'support_choice_required' }, 400, req)
  }
  if (!Number.isSafeInteger(displayedTotal) || displayedTotal < 0) {
    return json({ error: 'Odśwież stronę i sprawdź podsumowanie.', code: 'invalid_total' }, 400, req)
  }

  let withCookie = {}
  try {
    const ip = clientIp(req)
    const prepared = await prepareRegistration(req, admin, body, {
      pricing: (settings) => (settings.pricing_mode === 'free' ? 'free_event' : null),
      refusals: ORDER_REFUSALS,
      throttles: (email) => [
        { key: `order:${email}`, limit: ORDER_LIMIT, windowSeconds: HOUR },
        ...(ip ? [{ key: `order-ip:${ip}`, limit: ORDER_IP_LIMIT, windowSeconds: HOUR }] : []),
      ],
    })
    if (prepared.response) return prepared.response
    const { competition, settings, people, consentIds, email, profileId } = prepared
    withCookie = prepared.withCookie
    const answer = (payload, status) => json(payload, status, req, withCookie)

    // A total-0 order never reaches dpay, so missing dpay settings only refuse a paid order
    // (503, and the order is cancelled below like any other that got no redirect).
    let cfg = null
    try {
      cfg = dpayConfig(Deno.env)
    } catch (err) {
      console.error('create-order:', err?.message)
    }

    const { data: created, error } = await admin.rpc('create_order', {
      p_category_id: competition.category_id,
      p_people: people,
      p_profile_id: profileId,
      p_buyer_email: email,
      p_support_choice: supportChoice,
      p_displayed_total: displayedTotal,
      p_meta: { consentIds, ip, userAgent: req.headers.get('user-agent') || null },
    })
    if (error) {
      const msg = error.message ?? ''
      if (msg === 'not_found') return answer(NOT_FOUND, 404)
      if (msg === 'session_required') return answer({ error: 'Wpisz kod wysłany na adres e-mail.', code: 'code_required' }, 401)
      const changed = /^price_changed:(\d+)$/.exec(msg)
      if (changed) {
        const amounts = await currentAmounts(admin, settings, competition.category_id, people.length, supportChoice, Number(changed[1]))
        return answer({ error: PRICE_CHANGED, code: 'price_changed', amounts }, 409)
      }
      if (msg === 'duplicate') {
        const pendingId = await ownPendingOrder(admin, settings.event_id, email, profileId)
        if (pendingId) return answer({ error: PENDING_ORDER, code: 'pending_order', orderId: pendingId }, 409)
      }
      if (ORDER_REFUSALS[msg]) {
        const [status, text] = ORDER_REFUSALS[msg]
        return answer({ error: text, code: msg }, status)
      }
      throw error
    }

    const orderId = created.orderId
    if (created.status === 'paid') {
      await sendOrderConfirmation(admin, orderId)
      return answer({ data: { orderId, status: 'paid' } }, 201)
    }

    // From here the order holds a slot. Unless a redirect is handed out, it is cancelled.
    let handedOut = false
    let cancelReason = 'create_order_aborted'
    try {
      if (!cfg) {
        cancelReason = 'dpay_unconfigured'
        return answer({ error: 'Płatności online są chwilowo niedostępne.' }, 503)
      }
      let txn
      try {
        txn = await registerTransaction(cfg, { orderId, grosze: created.total })
      } catch (err) {
        console.error('create-order: dpay register failed:', err?.httpStatus ?? null, err?.message)
        await logPaymentEvent(admin, {
          kind: 'register', orderId,
          payload: { ok: false, httpStatus: err?.httpStatus ?? null, message: err?.message ?? null, grosze: created.total },
        })
        cancelReason = 'dpay_register_failed'
        return answer({ error: DPAY_DOWN, code: 'dpay_unavailable' }, 502)
      }

      const { data: attemptId, error: aErr } = await admin.rpc('add_payment_attempt', {
        p_order_id: orderId, p_txn: txn.transactionId, p_grosze: created.total,
      })
      if (aErr) {
        // A transaction we never hand out: nobody can pay it.
        console.error('create-order: add_payment_attempt failed:', aErr.message)
        if (aErr.message === 'full') {
          cancelReason = 'attempt_refused'
          return answer({ error: REFUSALS.full[1], code: 'full' }, 409)
        }
        if (aErr.message === 'not_payable') {
          cancelReason = 'attempt_refused'
          return answer({ error: REFUSALS.closed[1], code: 'closed' }, 409)
        }
        throw aErr
      }
      await logPaymentEvent(admin, {
        kind: 'register', orderId, attemptId,
        payload: { ok: true, transactionId: txn.transactionId, redirectUrl: txn.redirectUrl, grosze: created.total },
      })
      handedOut = true
      return answer({ data: { orderId, redirectUrl: txn.redirectUrl } }, 201)
    } finally {
      if (!handedOut) {
        try {
          const { error: cErr } = await admin.rpc('cancel_order', { p_order_id: orderId, p_reason: cancelReason })
          if (cErr) throw cErr
        } catch (err) {
          console.error('create-order: cancel_order failed:', err?.message)
          await raiseAlert(admin, 'cancel_failed', orderId, { reason: cancelReason })
        }
      }
    }
  } catch (err) {
    console.error('create-order error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req, withCookie)
  }
})
