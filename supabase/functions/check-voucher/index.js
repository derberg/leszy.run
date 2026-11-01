import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { clientIp } from '../_shared/clientIp.js'
import { clubRegistrationEnabled } from '../_shared/organizer.js'
import { checkAndIncrement } from '../_shared/throttle.js'
import { isUuid } from '../_shared/registration/organizerEvent.js'
import { isValidSlug } from '../_shared/registration/slug.js'
import { normalizeCode } from '../_shared/registration/vouchers.js'
import { voucherAnswer, voucherRefusal } from '../_shared/registration/voucherCheck.js'
import { CART_REFUSALS, NOT_FOUND, ORDER_REFUSALS, json, throttled } from '../_shared/registration/registrationRequest.js'

// POST { slug, categoryId, code } → 200 { data: { percent, price } }: the code's percent and the
// entry's price after it, at the competition's current list price (RA2's „Sprawdź”, Plan 7 task 8a).
// No session: the form checks the code before the e-mail step.
// Refusals: 422 { error, code, field: 'voucherCode' } with create-order's own copy (voucher_invalid,
// voucher_expired, voucher_category, voucher_used_up, voucher_not_applicable), decided like
// create_order (voucherCheck.js); a code of another event is voucher_invalid, nothing more. 404 for
// an unknown, draft, closed-down or hidden competition and a disabled club; 409 no_price.
// The answer never names the voucher, its partner, its note or its uses: only percent and price.
// Throttles per client IP and hour (claim_throttle_slot, one statement): voucher-ip:<ip> 30 checks,
// voucher-wrong-ip:<ip> 10 refused codes. The wrong slot is claimed before the check and given back
// when the code is accepted, so ten parallel guesses cannot all pass the cap.

const HOUR = 3600
const CHECKS_PER_HOUR = 30
const WRONG_PER_HOUR = 10

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, req)

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400, req) }
  const { slug, categoryId, code } = body ?? {}

  try {
    const ip = clientIp(req) ?? 'unknown'
    const checks = await checkAndIncrement(admin, `voucher-ip:${ip}`, CHECKS_PER_HOUR, { windowSeconds: HOUR })
    if (!checks.allowed) return throttled(req, checks.retryAfterSec)
    const wrongKey = `voucher-wrong-ip:${ip}`
    const wrong = await checkAndIncrement(admin, wrongKey, WRONG_PER_HOUR, { windowSeconds: HOUR })
    if (!wrong.allowed) return throttled(req, wrong.retryAfterSec)

    if (typeof slug !== 'string' || !isValidSlug(slug) || !isUuid(categoryId)) return json(NOT_FOUND, 404, req)
    const { data: settings, error: sErr } = await admin.from('registration_settings')
      .select('event_id, club_id, state, pricing_mode').eq('slug', slug).maybeSingle()
    if (sErr) throw sErr
    if (!settings || settings.state !== 'published') return json(NOT_FOUND, 404, req)
    if (!(await clubRegistrationEnabled(admin, settings.club_id))) return json(NOT_FOUND, 404, req)
    const { data: competition, error: cErr } = await admin.from('competitions')
      .select('category_id').eq('category_id', categoryId.toLowerCase()).eq('event_id', settings.event_id)
      .is('hidden_at', null).maybeSingle()
    if (cErr) throw cErr
    if (!competition) return json(NOT_FOUND, 404, req)

    // The list price create_order would charge now: the public read model's current tier.
    let listPrice = 0
    if (settings.pricing_mode !== 'free') {
      const { data: raw, error: rErr } = await admin.rpc('registration_raw', { p_event_id: settings.event_id })
      if (rErr) throw rErr
      listPrice = (raw?.competitions ?? []).find((c) => String(c.categoryId).toLowerCase() === competition.category_id)?.priceGrosze
      if (!Number.isSafeInteger(listPrice)) {
        const [status, error] = ORDER_REFUSALS.no_price
        return json({ error, code: 'no_price' }, status, req)
      }
    }

    const normalized = normalizeCode(code)
    let voucher = null
    let linked = []
    if (normalized) {
      const { data: v, error: vErr } = await admin.from('vouchers')
        .select('id, percent, used, max_uses, valid_until, disabled_at')
        .eq('event_id', settings.event_id).eq('code', normalized).maybeSingle()
      if (vErr) throw vErr
      voucher = v
      if (v) {
        const { data: links, error: lErr } = await admin.from('voucher_competitions').select('category_id').eq('voucher_id', v.id)
        if (lErr) throw lErr
        linked = (links ?? []).map((l) => l.category_id)
      }
    }

    const reason = voucherRefusal({ voucher, linkedCategoryIds: linked, categoryId: competition.category_id, listPrice })
    if (reason) {
      const [, error] = CART_REFUSALS[reason]
      return json({ error, code: reason, field: 'voucherCode' }, 422, req)
    }
    // An accepted code is not a wrong guess: its slot goes back.
    const { error: relErr } = await admin.rpc('release_throttle_slot', { p_key: wrongKey })
    if (relErr) console.error('check-voucher: release_throttle_slot:', relErr.message)
    return json({ data: voucherAnswer({ percent: voucher.percent, listPrice }) }, 200, req)
  } catch (err) {
    console.error('check-voucher error:', err?.message, err?.code)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
