import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { clientIp } from '../_shared/organizer.js'
import { dpayConfig } from '../_shared/dpay.js'
import { cartAmounts } from '../_shared/registration/pricing.js'
import { normalizeCode } from '../_shared/registration/vouchers.js'
import { cartMakesMoney } from '../_shared/registration/cart.js'
import {
  json, NOT_FOUND, ORDER_REFUSALS, PENDING_ORDER, PRICE_CHANGED, cartRefusal, fullRefusal, groupRefusal, orderThrottles,
  prepareRegistration, rpcPeople,
} from '../_shared/registration/registrationRequest.js'
import {
  DPAY_DOWN, PAYMENTS_OFF, ownPendingOrder, sendOrderConfirmation, startPaymentAttempt,
} from '../_shared/registration/orderFlow.js'
import { issueOrderConsentRequests } from '../_shared/registration/consentRequests.js'

// The amounts behind a price_changed refusal, priced as create_order prices (D7-21): each person's
// list price at their competition's current price from the public read model (the same tier choice
// create_order makes, D4-27), their code's percent (a plain read by the normalised code), their
// extras at the extra's price, plus the donation, through cartAmounts. `entryPrices` are the
// discounted entries, one per person in request order, so RA4 re-prices every line (Plan 3's shape). When they do not reproduce the RPC's total (something moved again in
// between) only the total goes back.
async function currentAmounts(admin, settings, people, donation, total) {
  try {
    const { data } = await admin.rpc('registration_raw', { p_event_id: settings.event_id })
    const free = settings.pricing_mode === 'free'
    const priceOf = new Map((data?.competitions ?? []).map((c) => [String(c.categoryId).toLowerCase(), c.priceGrosze]))
    const codes = [...new Set(people.map((p) => normalizeCode(p.voucherCode ?? '')).filter(Boolean))]
    const percentOf = new Map()
    if (codes.length) {
      const { data: vouchers, error } = await admin.from('vouchers').select('code, percent')
        .eq('event_id', settings.event_id).in('code', codes)
      if (error) throw error
      for (const v of vouchers ?? []) percentOf.set(v.code, v.percent)
    }
    const variantIds = [...new Set(people.flatMap((p) => (p.extras ?? []).map((e) => e.variantId.toLowerCase())))]
    const extraPriceOf = new Map()
    if (variantIds.length) {
      const { data: variants, error } = await admin.from('extra_variants').select('id, extras(price)').in('id', variantIds)
      if (error) throw error
      for (const v of variants ?? []) extraPriceOf.set(v.id, v.extras?.price)
    }
    const cart = people.map((p) => ({
      listPrice: free ? 0 : priceOf.get(String(p.categoryId).toLowerCase()),
      voucherPercent: p.voucherCode ? percentOf.get(normalizeCode(p.voucherCode)) ?? null : null,
      extras: (p.extras ?? []).filter((e) => e.qty > 0)
        .map((e) => ({ price: extraPriceOf.get(e.variantId.toLowerCase()), qty: e.qty })),
    }))
    const a = cartAmounts({ people: cart, donation })
    if (a.total === total) {
      return {
        entryPrices: a.lines.map((l) => l.price),
        entryTotal: a.entryTotal, extrasTotal: a.extrasTotal, donation: a.donation, total,
      }
    }
  } catch (err) {
    console.error('create-order: amounts for price_changed:', err?.message)
  }
  return { total }
}

// POST { people: [{ categoryId, person, guardianConsent? }], buyer?, acceptedConsentIds, serviceRegulamin,
//        displayedTotal, code?, donation? }, or Plan 3's { categoryId, person, … } (a group of one); each
//        person may carry voucherCode and extras [{ variantId, qty }] (Plan 7)
//   → 201 { data: { orderId, redirectUrl } }, or { data: { orderId, status: 'paid' } } when the total is 0.
// A group is one order, each person at their own competition's price (D4-27). register-free's body
// plus the total the page showed, which is only compared with the server's (409 price_changed with
// the amounts). A supportChoice from a page opened before 2026-10-31 is ignored. Every check before the RPC
// is register-free's (prepareRegistration). create_order writes the order (409 full when the paid
// entries fill a competition; an unpaid order claims no slot, P3-R15), then dpay registers the
// transaction. An order that leaves this function without a redirect handed out (a dpay failure, a
// refused attempt, any error) is cancelled (P3-R7). A resubmit that finds this buyer's own pending
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
      // Ruling 7: a free event takes an order only for its extras or a donation.
      pricing: (settings, cart) => (settings.pricing_mode === 'free' && !cartMakesMoney(cart) ? 'free_event' : null),
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
        const amounts = await currentAmounts(admin, settings, people, cart.donation, Number(changed[1]))
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

    // Unless a redirect is handed out, the order is cancelled (P3-R7).
    const attempt = await startPaymentAttempt(admin, cfg, { orderId, total: created.total, cancelOnFailure: true })
    if (attempt.redirectUrl) return answer({ data: { orderId, redirectUrl: attempt.redirectUrl } }, 201)
    if (attempt.refused === 'dpay_unconfigured') return answer({ error: PAYMENTS_OFF }, 503)
    if (attempt.refused === 'dpay_unavailable') return answer({ error: DPAY_DOWN, code: 'dpay_unavailable' }, 502)
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
