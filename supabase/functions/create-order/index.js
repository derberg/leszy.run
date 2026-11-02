import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { clientIp } from '../_shared/organizer.js'
import { dpayConfig } from '../_shared/dpay.js'
import { cartMakesMoney } from '../_shared/registration/cart.js'
import {
  json, NOT_FOUND, ORDER_REFUSALS, PENDING_ORDER, PRICE_CHANGED, cartChangedAmounts, cartRefusal, fullRefusal, groupRefusal, orderThrottles,
  prepareRegistration, rpcPeople,
} from '../_shared/registration/registrationRequest.js'
import {
  DPAY_DOWN, PAYMENTS_OFF, ownPendingOrder, sendOrderConfirmation, startPaymentAttempt,
} from '../_shared/registration/orderFlow.js'
import { issueOrderConsentRequests } from '../_shared/registration/consentRequests.js'

// POST { people: [{ categoryId, person, guardianConsent? }], buyer?, acceptedConsentIds, serviceRegulamin,
//        displayedTotal, code?, donation? }, or Plan 3's { categoryId, person, … } (a group of one); each
//        person may carry voucherCode and extras [{ variantId, qty }] (Plan 7)
//   → 201 { data: { orderId, redirectUrl } }, or { data: { orderId, status: 'paid' } } when the total is 0.
// A group is one order, each person at their own competition's price (D4-27). register-free's body
// plus the total the page showed, which is only compared with the server's (409 price_changed with
// the amounts). A supportChoice from a page opened before 2026-10-31 is ignored. Every check before the RPC
// is register-free's (prepareRegistration). create_order writes the order (409 full when the paid
// entries fill a competition; an unpaid order claims no slot, P3-R15), then dpay registers the
// transaction. An order that leaves this function without a redirect handed out (no dpay settings, a
// refused attempt, any error) is cancelled (P3-R7). When dpay refuses the transaction the order stays
// pending and the 502 names it, so the page sends the buyer to the order's „Zapłać”. A resubmit that finds this buyer's own pending
// order answers 409 pending_order with its id (P3-R8; any person of the group, D4-27). No e-mail goes
// out before payment: the consent requests to the group's added adults go out on confirmation
// (settleConfirmOutcome), or here for a 0 zł order, which is confirmed at once.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  const { displayedTotal } = body ?? {}
  if (!Number.isSafeInteger(displayedTotal) || displayedTotal < 0) {
    return json({ error: 'Odśwież stronę i sprawdź podsumowanie.', code: 'invalid_total' }, 400, req)
  }

  let withCookie = {}
  try {
    const ip = await clientIp(req)
    const prepared = await prepareRegistration(req, admin, body, {
      // Ruling 7: a free event takes an order only for its extras or a donation. With the money
      // features off (flags.js) a free event is free and a paid one waits for PAID_REGISTRATION_ENABLED.
      pricing: (settings, cart, { moneyLive }) => {
        if (!moneyLive) return settings.pricing_mode === 'free' ? 'free_event' : 'payments'
        return settings.pricing_mode === 'free' && !cartMakesMoney(cart) ? 'free_event' : null
      },
      refusals: ORDER_REFUSALS,
      throttles: orderThrottles(ip),
    })
    if (prepared.response) return prepared.response
    const { competitions, settings, people, consentIds, email, profileId, buyerName, legacy, cart } = prepared
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
      p_people: rpcPeople(people),
      p_profile_id: profileId,
      p_buyer_email: email,
      p_displayed_total: displayedTotal,
      p_meta: { consentIds, buyerName, ip, userAgent: req.headers.get('user-agent') || null, donation: cart.donation },
    })
    if (error) {
      const msg = error.message ?? ''
      if (msg === 'not_found') return answer(NOT_FOUND, 404)
      const refusedCart = cartRefusal(msg)
      if (refusedCart) return answer(refusedCart[1], refusedCart[0])
      if (msg === 'session_required') return answer({ error: 'Wpisz kod wysłany na adres e-mail.', code: 'code_required' }, 401)
      const changed = /^price_changed:(\d+)$/.exec(msg)
      if (changed) {
        const amounts = await cartChangedAmounts(admin, settings, people, cart.donation, Number(changed[1]))
        return answer({ error: PRICE_CHANGED, code: 'price_changed', amounts }, 409)
      }
      if (/^duplicate:\d+$/.test(msg)) {
        const pendingId = await ownPendingOrder(admin, settings.event_id, people, profileId)
        if (pendingId) return answer({ error: PENDING_ORDER, code: 'pending_order', orderId: pendingId }, 409)
      }
      const group = await groupRefusal(admin, msg, { competitions, people, legacy, email })
      if (group) return answer(group[1], group[0])
      if (ORDER_REFUSALS[msg]) {
        const [status, text] = ORDER_REFUSALS[msg]
        return answer({ error: text, code: msg }, status)
      }
      throw error
    }

    const orderId = created.orderId
    // The name the buyer typed, for the consent e-mails that go out when the payment lands (m-1).
    // Best effort: without it they name the buyer's own entry or account, never the address.
    const { error: nameErr } = await admin.from('orders').update({ buyer_name: buyerName }).eq('id', orderId)
    if (nameErr) console.error('create-order: buyer_name not stored:', nameErr.message)
    if (created.status === 'paid') {
      await sendOrderConfirmation(admin, orderId)
      await issueOrderConsentRequests(admin, orderId, { registeredBy: buyerName })
      return answer({ data: { orderId, status: 'paid' } }, 201)
    }

    // Unless a redirect is handed out, the order is cancelled (P3-R7), except when dpay refused it.
    const attempt = await startPaymentAttempt(admin, cfg, { orderId, total: created.total, cancelOnFailure: true })
    if (attempt.redirectUrl) return answer({ data: { orderId, redirectUrl: attempt.redirectUrl } }, 201)
    if (attempt.refused === 'dpay_unconfigured') return answer({ error: PAYMENTS_OFF }, 503)
    if (attempt.refused === 'dpay_unavailable') return answer({ error: DPAY_DOWN, code: 'dpay_unavailable', orderId }, 502)
    if (attempt.refused === 'full') {
      const { data: comps } = await admin.from('competitions')
        .select('category_id, name, taken, capacity').in('category_id', [...competitions.keys()])
      return answer(fullRefusal(comps ?? [], people, { legacy }), 409)
    }
    return answer({ error: ORDER_REFUSALS.closed[1], code: 'closed' }, 409)
  } catch (err) {
    console.error('create-order error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req, withCookie)
  }
})
