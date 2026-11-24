// Moving a live entry to another competition, the part every caller shares (the organizer's
// organizer-entry-action now, the runner's own endpoint later with actorKind 'runner'):
//   changePreview / changeTargets  what each competition would cost and whether the move is allowed,
//                                  by change_competition's own rules (read-only, nothing locked: the
//                                  RPC decides, this list only keeps the dialog from offering what it
//                                  would refuse);
//   runChange                      change_competition, then what follows the stored outcome: the
//                                  difference refund through dpay (organizer-refund's lifecycle), the
//                                  surcharge request e-mail, or the change notice.
// Once change_competition has committed, nothing here throws: a failure is logged and alerted, never
// a 500, because the organizer who sees an error retries a move that already happened.
import { ageOn } from './ageGroups.js'
import { currentTier } from './pricing.js'
import { warsawDayStart, warsawToday } from './dates.js'
import { changeKind, changeQuote } from './competitionChange.js'
import { claimRefundRequest, executeRefund, raiseAlert } from './orderFlow.js'
import { refundsInFlight } from './refundInFlight.js'
import { sendCompetitionChanged, sendSurchargeEmail } from './competitionChangeMail.js'

async function single(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

// Online payment stops an hour before closes_at (create_order's and change_competition's rule).
const PAYING_CLOSES_BEFORE_MS = 3600_000
const ADULT = 18

const REG_COLUMNS = 'id, event_id, category_id, status, team_id, order_id, price, refunded, list_price, voucher_id, birth_date, gender, email'

/**
 * Everything the preview and the RPC's pre-checks read for one entry → null when it does not exist.
 * Plain reads; the RPC re-reads all of it under its locks.
 */
async function loadContext(admin, registrationId) {
  const reg = await single(admin.from('registrations').select(REG_COLUMNS).eq('id', registrationId).maybeSingle())
  if (!reg) return null
  const [settings, order, comps, extraLines] = await Promise.all([
    single(admin.from('registration_settings')
      .select('event_id, club_id, state, closes_at, event_date, age_reckoning').eq('event_id', reg.event_id).single()),
    reg.order_id
      ? single(admin.from('orders').select('id, tier_id, status, paid_offline_at').eq('id', reg.order_id).maybeSingle())
      : null,
    single(admin.from('competitions')
      .select('category_id, name, kind, hidden_at, min_age, max_age, capacity, taken, sort_order')
      .eq('event_id', reg.event_id).order('sort_order').order('category_id')),
    reg.order_id
      ? single(admin.from('order_lines').select('extra_variant_id, amount, refunded')
        .eq('order_id', reg.order_id).eq('registration_id', reg.id).eq('kind', 'extra'))
      : [],
  ])
  return { reg, settings, order, comps: comps ?? [], extraLines: extraLines ?? [] }
}

/** The list price of each competition: in the order's frozen tier, or (no order) the current tier. */
async function listPrices(admin, ctx) {
  const ids = ctx.comps.map((c) => c.category_id)
  if (!ids.length) return new Map()
  let tierId = ctx.order?.tier_id ?? null
  if (!ctx.order) {
    const tiers = await single(admin.from('price_tiers').select('id, ends_on, sort_order').eq('event_id', ctx.reg.event_id))
    const tier = currentTier((tiers ?? []).map((t) => ({ id: t.id, endsOn: t.ends_on, sortOrder: t.sort_order })))
    tierId = tier?.id ?? null
  }
  if (!tierId) return new Map()
  const rows = await single(admin.from('competition_prices').select('category_id, amount').eq('tier_id', tierId).in('category_id', ids))
  return new Map((rows ?? []).map((p) => [p.category_id, p.amount]))
}

/** The entry's voucher: { percent, categories: Set | null (offered everywhere) } or null. */
async function voucherOf(admin, voucherId) {
  if (!voucherId) return null
  const [v, links] = await Promise.all([
    single(admin.from('vouchers').select('percent').eq('id', voucherId).maybeSingle()),
    single(admin.from('voucher_competitions').select('category_id').eq('voucher_id', voucherId)),
  ])
  if (!v) return null
  return { percent: v.percent, categories: links?.length ? new Set(links.map((l) => l.category_id)) : null }
}

/** The extras the entry holds: [{ name, categories: Set | null }]. */
async function heldExtras(admin, lines) {
  const variantIds = [...new Set(lines.filter((l) => l.refunded < l.amount || l.amount === 0).map((l) => l.extra_variant_id))]
  if (!variantIds.length) return []
  const variants = await single(admin.from('extra_variants').select('id, extra_id').in('id', variantIds))
  const extraIds = [...new Set((variants ?? []).map((v) => v.extra_id))]
  if (!extraIds.length) return []
  const [extras, links] = await Promise.all([
    single(admin.from('extras').select('id, name').in('id', extraIds)),
    single(admin.from('extra_competitions').select('extra_id, category_id').in('extra_id', extraIds)),
  ])
  return (extras ?? []).map((e) => {
    const cats = (links ?? []).filter((l) => l.extra_id === e.id).map((l) => l.category_id)
    return { name: e.name, categories: cats.length ? new Set(cats) : null }
  })
}

/** change_competition's entry checks, in its order → the refusal code or null. */
async function entryRefusal(admin, ctx, now) {
  const { reg, settings } = ctx
  if (reg.status !== 'confirmed') return 'not_live'
  if (reg.team_id) return 'team_competition'
  if (settings.state !== 'published' || !settings.closes_at || now.getTime() >= Date.parse(settings.closes_at)) return 'edits_closed'
  if ((await refundsInFlight(admin, [reg.id])).has(reg.id)) return 'refund_pending'
  const surcharge = await single(admin.from('orders').select('id')
    .eq('kind', 'surcharge').eq('surcharge_registration_id', reg.id).eq('status', 'pending')
    .gt('expires_at', now.toISOString()).limit(1))
  if (surcharge?.length) return 'surcharge_open'
  const transfer = await single(admin.from('transfers').select('id')
    .eq('registration_id', reg.id).eq('status', 'pending').gt('expires_at', now.toISOString()).limit(1))
  if (transfer?.length) return 'transfer_open'
  return null
}

/**
 * The dialog's preview for one entry → { refusal } when the entry cannot move at all (null if it
 * does not exist), else { entry: { registrationId, categoryId, held, offlinePaid }, targets }.
 * Each target: { categoryId, name, listPrice, price, difference, kind, voucherKept,
 * extrasNotOffered: [name], eligible, reason?, offlineAck? } with change_competition's numbers
 * (changeQuote): the price in the order's frozen tier (no order: the current tier, which must be
 * 0 zł), the voucher kept only where it is offered, difference = price − (price paid − refunded).
 * `reason` is the code the RPC would raise for that target; `offlineAck` marks a cheaper move of an
 * entry paid outside LESZY.RUN (the club gives the difference back by hand and must say so).
 */
export async function changePreview(admin, registrationId, { now = new Date() } = {}) {
  const ctx = await loadContext(admin, registrationId)
  if (!ctx) return null
  const refusal = await entryRefusal(admin, ctx, now)
  if (refusal) return { refusal }
  const { reg, settings, order } = ctx
  const [prices, voucher, extras] = await Promise.all([
    listPrices(admin, ctx), voucherOf(admin, reg.voucher_id), heldExtras(admin, ctx.extraLines),
  ])
  const held = reg.price - reg.refunded
  const raceDay = settings.event_date ?? warsawToday(now)
  const minor = ageOn(reg.birth_date, raceDay, 'race_day') < ADULT
  const refundsClosed = !settings.event_date || now.getTime() >= warsawDayStart(settings.event_date).getTime()
  const payingClosed = now.getTime() >= Date.parse(settings.closes_at) - PAYING_CLOSES_BEFORE_MS
  const offlinePaid = Boolean(order?.paid_offline_at)

  const targets = ctx.comps
    .filter((c) => c.category_id !== reg.category_id && !c.hidden_at && c.kind === 'individual')
    .map((c) => {
      const age = ageOn(reg.birth_date, raceDay, settings.age_reckoning ?? 'race_day')
      let reason = null
      let listPrice = order ? prices.get(c.category_id) ?? null : prices.get(c.category_id) ?? 0
      if ((c.min_age != null && age < c.min_age) || (c.max_age != null && age > c.max_age)) reason = 'ineligible'
      else if (minor !== (reg.email == null)) reason = 'role_change'
      else if (!order && listPrice > 0) reason = 'no_payer'
      else if (order && listPrice == null) reason = 'no_price'
      if (listPrice == null) listPrice = 0
      const covers = voucher ? voucher.categories == null || voucher.categories.has(c.category_id) : false
      const quote = changeQuote({ held, listPriceTarget: listPrice, voucherPercent: voucher?.percent ?? null, voucherCoversTarget: covers })
      const kind = changeKind(quote.difference)
      if (!reason) {
        if (kind === 'refund' && !order) reason = 'no_payer'
        else if (kind === 'refund' && !offlinePaid && refundsClosed) reason = 'race_day'
        else if (kind === 'surcharge' && !order) reason = 'no_payer'
        else if (kind === 'surcharge' && payingClosed) reason = 'paying_closed'
        else if (c.taken + 1 > c.capacity) reason = 'full'
      }
      return {
        categoryId: c.category_id,
        name: c.name,
        listPrice: quote.listPrice,
        price: quote.price,
        difference: quote.difference,
        kind,
        voucherKept: quote.voucherKept,
        extrasNotOffered: extras.filter((e) => e.categories && !e.categories.has(c.category_id)).map((e) => e.name),
        eligible: !reason,
        ...(reason ? { reason } : {}),
        ...(kind === 'refund' && offlinePaid ? { offlineAck: true } : {}),
      }
    })
  return { entry: { registrationId: reg.id, categoryId: reg.category_id, held, offlinePaid }, targets }
}

/** The targets alone ([] when the entry cannot move or does not exist). */
export async function changeTargets(admin, registrationId, opts) {
  const preview = await changePreview(admin, registrationId, opts)
  return preview?.targets ?? []
}

// --------------------------------------------------------------------------- runChange

/** An RPC error → { code, difference?, remaining? }, or null when it is no refusal (a 500). */
export function changeRpcRefusal(error) {
  const msg = error?.message ?? ''
  const price = /^price_changed:(-?\d+)$/.exec(msg)
  if (price) return { code: 'price_changed', difference: Number(price[1]) }
  const exceeds = /^exceeds:(\d+)$/.exec(msg)
  if (exceeds) return { code: 'exceeds', remaining: Number(exceeds[1]) }
  if (/^[a-z_]+$/.test(msg)) return { code: msg }
  return null
}

const callChange = (admin, args) => admin.rpc('change_competition', {
  p_registration_id: args.registrationId, p_to: args.categoryId, p_expected_difference: args.expectedDifference,
  p_actor: args.actor ?? null, p_actor_kind: args.actorKind, p_request_key: args.requestKey,
  p_offline_ack: args.offlineAck === true,
})

// A part's stored dpay state when this call did not execute it (a replay, or claimed elsewhere).
async function storedStatus(admin, refundId, orderId) {
  const row = await single(admin.from('refunds').select('dpay_status').eq('id', refundId).single())
  if (row.dpay_status === 'rejected') {
    const alerts = await single(admin.from('operator_alerts').select('payload').eq('order_id', orderId).eq('kind', 'refund_blocked'))
    if ((alerts ?? []).some((a) => a.payload?.refundId === refundId)) return 'blocked'
  }
  return row.dpay_status
}

/** Every part's state → one: all accepted → accepted; any unknown → unknown; else the refusal. */
function overallStatus(statuses) {
  if (statuses.every((s) => s === 'accepted')) return 'accepted'
  if (statuses.some((s) => s === 'unknown' || s === 'pending')) return 'unknown'
  if (statuses.includes('blocked')) return 'blocked'
  if (statuses.includes('insufficient_balance')) return 'insufficient_balance'
  return 'rejected'
}

/**
 * Executes the reserved difference refund, part by part, as organizer-refund does: claim (at most
 * one dpay call), executeRefund through finish_organizer_refund, an insufficient_balance alert (an
 * organizer refund is never retried). → [{ refundId, grosze, orderId, status, executed }]
 */
async function executeParts(admin, cfg, parts, log) {
  const out = []
  for (const p of parts) {
    const refund = await single(admin.from('refunds').select('id, order_id, payment_attempt_id').eq('id', p.refundId).single())
    if (!(await claimRefundRequest(admin, p.refundId))) {
      out.push({ refundId: p.refundId, grosze: p.grosze, orderId: refund.order_id, status: await storedStatus(admin, p.refundId, refund.order_id), executed: false })
      continue
    }
    let finished = null
    const outcome = await executeRefund(admin, cfg, {
      orderId: refund.order_id, txn: p.transactionId, refundId: p.refundId, messageId: p.messageId,
      attemptId: refund.payment_attempt_id, grosze: p.grosze, reason: 'competition_change', partial: true,
      source: 'organizer', organizer: true, onSettled: (data) => { finished = data },
    })
    let status = finished ? (finished.status ?? outcome) : 'unknown'
    if (finished && finished.settled !== 'already_settled' && outcome === 'blocked') status = 'blocked'
    if (finished && finished.settled !== 'already_settled') {
      try {
        if (outcome === 'insufficient_balance') {
          await raiseAlert(admin, 'refund_insufficient_balance', refund.order_id, {
            refundId: p.refundId, txn: p.transactionId, grosze: p.grosze, reason: 'organizer',
          })
        }
        await log('refund_settled', p.refundId, { status, grosze: p.grosze, cancelled: [] })
      } catch (err) {
        console.error('competition change: refund follow-up:', err?.message)
        await raiseAlert(admin, 'refund_followup_failed', refund.order_id, { refundId: p.refundId, status, error: String(err?.message ?? err) })
      }
    }
    out.push({ refundId: p.refundId, grosze: p.grosze, orderId: refund.order_id, status, executed: true })
  }
  return out
}

/** Claims runner_notified_at on accepted parts, so registration-jobs sends no second refund mail. */
async function claimNotified(admin, refundIds) {
  if (!refundIds.length) return []
  const { data, error } = await admin.from('refunds').update({ runner_notified_at: new Date().toISOString() })
    .in('id', refundIds).is('runner_notified_at', null).select('id')
  if (error) throw error
  return (data ?? []).map((r) => r.id)
}

/**
 * change_competition and what follows it.
 * @param {object} admin service-role client
 * @param {object|null} cfg dpay config (null when not configured: a refund through dpay is refused)
 * @param {{ registrationId, categoryId, expectedDifference, requestKey, actor, actorKind, offlineAck? }} args
 * @param {{ log?: (action, target, payload) => Promise<unknown> }} [opts] the caller's audit
 * @returns {Promise<{ refused: string, difference?: number, remaining?: number }
 *   | { outcome: 'moved'|'moved_offline_refund'|'surcharge'|'refund', fromCategoryId, toCategoryId, grosze,
 *       orderId?, expiresAt?, refund?: { status, refundIds, acceptedGrosze, replay }, emailed }>}
 */
export async function runChange(admin, cfg, args, { log = async () => {} } = {}) {
  const reg = await single(admin.from('registrations').select('id, category_id, order_id').eq('id', args.registrationId).maybeSingle())
  if (!reg) return { refused: 'not_found' }
  if (!cfg && Number.isInteger(args.expectedDifference) && args.expectedDifference < 0) {
    const order = reg.order_id ? await single(admin.from('orders').select('paid_offline_at').eq('id', reg.order_id).maybeSingle()) : null
    if (!order?.paid_offline_at) return { refused: 'dpay_not_configured' }
  }
  const fromCategoryId = reg.category_id

  let res = await callChange(admin, args)
  // change_retry: the entry moved between the RPC's plain read and its lock; once more.
  if (res.error?.message === 'change_retry') res = await callChange(admin, args)
  if (res.error) {
    const refused = changeRpcRefusal(res.error)
    if (!refused) throw res.error
    const { code, ...rest } = refused
    return { refused: code, ...rest }
  }
  const out = res.data
  const base = { outcome: out.outcome, fromCategoryId, toCategoryId: args.categoryId, grosze: out.grosze }
  const alertOrder = reg.order_id ?? null

  // The money state is stored: from here on nothing throws.
  if (out.outcome === 'surcharge') {
    let emailed = false
    try {
      await log('competition_changed', reg.id, { fromCategoryId, toCategoryId: args.categoryId, outcome: out.outcome, grosze: out.grosze, orderId: out.orderId })
      await log('surcharge_created', out.orderId, { registrationId: reg.id, grosze: out.grosze })
      const mail = await sendSurchargeEmail(admin, out.orderId)
      emailed = mail.sent === true
      if (!emailed) await raiseAlert(admin, 'email_failed', out.orderId, { template: 'surcharge', error: mail.error })
    } catch (err) {
      console.error('competition change: surcharge follow-up:', err?.message)
    }
    return { ...base, orderId: out.orderId, expiresAt: out.expiresAt, emailed }
  }

  if (out.outcome === 'moved' || out.outcome === 'moved_offline_refund') {
    let emailed = false
    try {
      await log('competition_changed', reg.id, { fromCategoryId, toCategoryId: args.categoryId, outcome: out.outcome, grosze: out.grosze })
      // An offline difference goes back by hand: the notice says nothing about money.
      const mail = await sendCompetitionChanged(admin, { registrationId: reg.id, fromCategoryId, toCategoryId: args.categoryId })
      emailed = mail.sent === true
      if (!emailed && mail.error) await raiseAlert(admin, 'email_failed', alertOrder, { template: 'competition_changed', registrationId: reg.id, error: mail.error })
    } catch (err) {
      console.error('competition change: follow-up:', err?.message)
    }
    return { ...base, emailed }
  }

  // refund: the parts are reserved; run each through dpay exactly once.
  const parts = out.refunds ?? []
  let results
  try {
    results = await executeParts(admin, cfg, parts, log)
  } catch (err) {
    // A read failed around a dpay call: what is stored is the refund's own state, unknown here.
    console.error('competition change: refund execution:', err?.message)
    await raiseAlert(admin, 'refund_followup_failed', alertOrder, { refundIds: parts.map((p) => p.refundId), error: String(err?.message ?? err) })
    results = parts.map((p) => ({ ...p, status: 'unknown', executed: false }))
  }
  const status = overallStatus(results.map((r) => r.status))
  const refundIds = results.map((r) => r.refundId)
  let acceptedGrosze = 0
  let emailed = false
  try {
    if (!out.replay) {
      await log('competition_changed', reg.id, {
        fromCategoryId, toCategoryId: args.categoryId, outcome: 'refund', grosze: out.grosze, refundIds,
      })
    }
    const accepted = results.filter((r) => r.status === 'accepted')
    const claimed = await claimNotified(admin, accepted.map((r) => r.refundId))
    acceptedGrosze = accepted.filter((r) => claimed.includes(r.refundId)).reduce((n, r) => n + r.grosze, 0)
    // The change notice once: on the first call, or on a replay that newly settled a refund.
    if (!out.replay || claimed.length) {
      const mail = await sendCompetitionChanged(admin, {
        registrationId: reg.id, fromCategoryId, toCategoryId: args.categoryId, refundGrosze: acceptedGrosze > 0 ? acceptedGrosze : null,
      })
      emailed = mail.sent === true
      if (!emailed) {
        // Nothing went out: the refunds' own e-mail (registration-jobs' refund_emails) tells the payer instead.
        if (claimed.length) {
          const { error } = await admin.from('refunds').update({ runner_notified_at: null }).in('id', claimed)
          if (error) console.error('competition change: refund mail claim not given back:', error.message)
        }
        if (mail.error) await raiseAlert(admin, 'email_failed', alertOrder, { template: 'competition_changed', registrationId: reg.id, error: mail.error })
      }
    }
  } catch (err) {
    console.error('competition change: refund follow-up:', err?.message)
    await raiseAlert(admin, 'refund_followup_failed', alertOrder, { refundIds, status, error: String(err?.message ?? err) })
  }
  return { ...base, refund: { status, refundIds, acceptedGrosze, replay: out.replay === true }, emailed }
}
