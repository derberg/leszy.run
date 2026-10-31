import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { clientIp } from '../_shared/organizer.js'
import { dpayConfig } from '../_shared/dpay.js'
import {
  json, PENDING_ORDER, REFUSALS, TEAM_REFUSALS, prepareRegistration, rpcPeople, teamRefusal,
} from '../_shared/registration/registrationRequest.js'
import {
  DPAY_DOWN, PAYMENTS_OFF, ownPendingOrder, sendOrderConfirmation, sendTeamConfirmation, startPaymentAttempt,
} from '../_shared/registration/orderFlow.js'
import { issueConsentRequests, issueOrderConsentRequests } from '../_shared/registration/consentRequests.js'

// Throttles (claim_throttle_slot): the same counters as create-order, so a team and an order
// share one allowance. prepareRegistration adds the buyer's 30 people a day.
const ORDER_LIMIT = 10
const ORDER_IP_LIMIT = 20
const HOUR = 3600

// POST { categoryId, teamName, members: [{ person, leg?, guardianConsent? }], membersConsent,
//        acceptedConsentIds, serviceRegulamin, displayedTotal, code?, website? }
//   → 201 { data: { orderId, teamId, redirectUrl } }, or { data: { teamId, status: 'confirmed' } }
//     (with orderId for a 0 zł fee on a paid event, D5-23).
// Member 0 is the captain: the session must be that address, otherwise the e-mail code for it logs
// them in and sets the cookie. A filled `website` is the form's honeypot, answered as
// auth-request-code answers it, with nothing written. create_team_registration writes the team in
// one transaction; a paid team claims no slot until its fee lands (P3-R15). The status decides what
// follows, never the orderId: a 0 zł team has an order and goes nowhere near dpay. No e-mail goes
// out before payment: a paid team's confirmation and consent requests come from settleConfirmOutcome.
// An order that leaves without a redirect is cancelled, which frees the name (P3-R7, D5-24). A resubmit
// while this captain's team waits for payment answers 409 pending_order with its id, also when
// their own pending team is what holds the name.
Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }

  if (body?.website) return json({ success: true }, 200, req)

  const { displayedTotal } = body ?? {}
  if (!Number.isSafeInteger(displayedTotal) || displayedTotal < 0) {
    return json({ error: 'Odśwież stronę i sprawdź podsumowanie.', code: 'invalid_total' }, 400, req)
  }

  let withCookie = {}
  try {
    const ip = clientIp(req)
    const prepared = await prepareRegistration(req, admin, body, {
      team: true,
      pricing: () => null,
      refusals: TEAM_REFUSALS,
      throttles: (email) => [
        ...(ip ? [{ key: `order-ip:${ip}`, limit: ORDER_IP_LIMIT, windowSeconds: HOUR }] : []),
        { key: `order:${email}`, limit: ORDER_LIMIT, windowSeconds: HOUR },
      ],
    })
    if (prepared.response) return prepared.response
    const { competition, settings, people, teamName, consentIds, email, profileId, buyerName } = prepared
    withCookie = prepared.withCookie
    const answer = (payload, status) => json(payload, status, req, withCookie)

    // A team that needs no payment never reaches dpay, so missing settings only refuse a paid one.
    let cfg = null
    try {
      cfg = dpayConfig(Deno.env)
    } catch (err) {
      console.error('register-team:', err?.message)
    }

    const { data: created, error } = await admin.rpc('create_team_registration', {
      p_category_id: competition.category_id,
      p_team_name: teamName,
      p_members: rpcPeople(people),
      p_profile_id: profileId,
      p_buyer_email: email,
      p_displayed_total: displayedTotal,
      p_meta: { consentIds, buyerName, ip, userAgent: req.headers.get('user-agent') || null },
    })
    if (error) {
      const msg = error.message ?? ''
      if (msg === 'team_name_taken' || /^duplicate:\d+$/.test(msg)) {
        const pendingId = await ownPendingOrder(admin, settings.event_id, people, profileId)
        if (pendingId) return answer({ error: PENDING_ORDER, code: 'pending_order', orderId: pendingId }, 409)
      }
      const refused = await teamRefusal(admin, error, { competition, people, email })
      if (refused) return answer(refused[1], refused[0])
      throw error
    }

    const { orderId, teamId } = created
    if (created.status === 'confirmed') {
      if (orderId) {
        await sendOrderConfirmation(admin, orderId)
        await issueOrderConsentRequests(admin, orderId, { registeredBy: buyerName })
      } else {
        await sendTeamConfirmation(admin, teamId, email)
        const adults = created.registrations.filter((r) => r.role === 'adult').map((r) => r.id)
        await issueConsentRequests(admin, adults, { registeredBy: buyerName })
      }
      return answer({ data: { teamId, status: 'confirmed', ...(orderId ? { orderId } : {}) } }, 201)
    }

    const attempt = await startPaymentAttempt(admin, cfg, { orderId, total: created.total, cancelOnFailure: true })
    if (attempt.redirectUrl) return answer({ data: { orderId, teamId, redirectUrl: attempt.redirectUrl } }, 201)
    if (attempt.refused === 'dpay_unconfigured') return answer({ error: PAYMENTS_OFF }, 503)
    if (attempt.refused === 'dpay_unavailable') return answer({ error: DPAY_DOWN, code: 'dpay_unavailable' }, 502)
    if (attempt.refused === 'full') return answer({ error: TEAM_REFUSALS.full[1], code: 'full' }, 409)
    return answer({ error: REFUSALS.closed[1], code: 'closed' }, 409)
  } catch (err) {
    console.error('register-team error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req, withCookie)
  }
})
