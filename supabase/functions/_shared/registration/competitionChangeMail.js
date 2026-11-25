// The e-mails of a competition change (a registration moved to another competition, a dearer move
// through a surcharge order). Sent as the club („<klub> przez LESZY.RUN”, reply-to the event's
// contact address, clubSender), click tracking off like every payment mail (the link is the order
// page). Names only the event and the two competitions: never a person, never the payer's address
// in the runner's mail (each recipient gets the same text and nobody sees the others).
//
// The helpers return { sent, error } and never throw, except the two `deliver…` functions the
// order-confirmation claim wraps (orderFlow.js sendOrderConfirmation), which throw when nothing
// certainly went out so that claim is given back or alerted as for any confirmation.
import { sendEmailToEach } from '../email.js'
import {
  competitionChangedEmail, surchargeEmail, surchargeExpiredEmail, surchargeRefundedEmail,
} from './emails.js'
import { consentRecipient } from './group.js'
import { clubSender } from './organizerSender.js'
import { publicSite } from './consentRequests.js'

async function single(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

const REG_COLUMNS = 'id, event_id, order_id, email, guardian_email, profile_id, registered_by_profile_id, guardian_name, guardian_profile_id, guardian_removed_at, guardian_named, consent_state'

async function settingsOf(admin, eventId) {
  return single(admin.from('registration_settings').select('event_id, club_id, name, contact_email').eq('event_id', eventId).maybeSingle())
}

async function competitionNames(admin, ids) {
  const data = await single(admin.from('competitions').select('category_id, name').in('category_id', ids))
  return new Map((data ?? []).map((c) => [c.category_id, c.name]))
}

const lower = (a) => (typeof a === 'string' && a.trim() ? a.trim().toLowerCase() : null)
const unique = (list) => [...new Set(list.filter(Boolean))]

/** The surcharge order with what its mails name: { order, settings, from, to } or null. */
async function surchargeOf(admin, orderId) {
  const order = await single(admin.from('orders').select('*').eq('id', orderId).maybeSingle())
  if (!order || order.kind !== 'surcharge') return null
  const [settings, names] = await Promise.all([
    settingsOf(admin, order.event_id),
    competitionNames(admin, [order.surcharge_from_category_id, order.surcharge_to_category_id]),
  ])
  if (!settings) return null
  return {
    order,
    settings,
    from: names.get(order.surcharge_from_category_id) ?? '',
    to: names.get(order.surcharge_to_category_id) ?? '',
  }
}

// One send to every address, as the club. Throws when the send did not go out (a SendGrid refusal
// or an error), with `status` and `deliveryUnknown` as email.js sets them.
async function deliver(admin, settings, addresses, mail, { noTracking = true } = {}) {
  if (!addresses.length) return false
  const sender = await clubSender(admin, settings)
  const res = await sendEmailToEach(addresses, { ...mail, ...sender, noTracking })
  if (res && res.ok === false) throw Object.assign(new Error(`e-mail not accepted (${res.status})`), { status: res.status })
  return true
}

const outcome = async (fn) => {
  try {
    return { sent: await fn(), error: null }
  } catch (err) {
    console.error('competition change e-mail failed:', err?.message)
    return { sent: false, error: String(err?.message ?? err) }
  }
}

/**
 * The surcharge request (or its reminder) to the payer. `site` is the link base when the caller has
 * one (the job); else PUBLIC_SITE_URL. → { sent, error }
 */
export function sendSurchargeEmail(admin, orderId, { reminder = false, site = null } = {}) {
  return outcome(async () => {
    const s = await surchargeOf(admin, orderId)
    const to = lower(s?.order.buyer_email)
    if (!to) return false
    const url = `${publicSite(site)}/zamowienie/${encodeURIComponent(orderId)}`
    return deliver(admin, s.settings, [to], surchargeEmail({
      eventName: s.settings.name, from: s.from, to: s.to, grosze: s.order.total, url, expiresAt: s.order.expires_at, reminder,
    }))
  })
}

/** „Dopłata wygasła” to the payer. → { sent, error } */
export function sendSurchargeExpired(admin, orderId) {
  return outcome(async () => {
    const s = await surchargeOf(admin, orderId)
    const to = lower(s?.order.buyer_email)
    if (!to) return false
    return deliver(admin, s.settings, [to], surchargeExpiredEmail({ eventName: s.settings.name, from: s.from }))
  })
}

/** „Dopłata zwrócona” to the payer: the surcharge was paid and refunded in full, `reason` as refunds.reason. */
export function sendSurchargeRefunded(admin, orderId, reason) {
  return outcome(async () => {
    const s = await surchargeOf(admin, orderId)
    const to = lower(s?.order.buyer_email)
    if (!to) return false
    return deliver(admin, s.settings, [to], surchargeRefundedEmail({
      eventName: s.settings.name, from: s.from, to: s.to, grosze: s.order.total, reason,
    }), { noTracking: false })
  })
}

// The change notice, throwing. Recipients: the entry's own address (a child's: the guardian's),
// the buyer of every order a refund of this change actually went back to and, for a settled
// surcharge, its buyer; deduplicated.
// The money recipients come from the refunds themselves (`refundIds` → refunds.order_id → that
// order's buyer), never from the entry's original order (security review L-1): after a package
// transfer that order's buyer no longer holds the entry, and a cheaper move refunds the newest
// paid lines first, which may be a surcharge somebody else paid. So the original buyer hears of
// the move only when part of the difference goes back to their own order.
async function deliverChange(admin, { registrationId, fromCategoryId, toCategoryId, refundGrosze = null, refundIds = [], surchargeBuyer = null }) {
  const reg = await single(admin.from('registrations').select(REG_COLUMNS).eq('id', registrationId).maybeSingle())
  if (!reg) return false
  const ids = refundGrosze > 0 ? unique(refundIds ?? []) : []
  const refundOrders = ids.length
    ? unique((await single(admin.from('refunds').select('order_id').in('id', ids))).map((r) => r.order_id))
    : []
  const payers = refundOrders.length
    ? await single(admin.from('orders').select('buyer_email').in('id', refundOrders))
    : []
  const settings = await settingsOf(admin, reg.event_id)
  if (!settings) return false
  const names = await competitionNames(admin, [fromCategoryId, toCategoryId])
  const addresses = unique([consentRecipient(reg), ...payers.map((o) => o.buyer_email), surchargeBuyer].map(lower))
  return deliver(admin, settings, addresses, competitionChangedEmail({
    eventName: settings.name, from: names.get(fromCategoryId) ?? '', to: names.get(toCategoryId) ?? '', refundGrosze,
  }))
}

/**
 * „Zmieniono konkurencję” to the runner and the payer (one address once). `refundGrosze` adds the
 * line about the difference when a cheaper move was refunded; `refundIds` are the refunds that
 * line counts, whose orders' buyers get the notice too. → { sent, error }
 */
export function sendCompetitionChanged(admin, args) {
  return outcome(() => deliverChange(admin, args))
}

/**
 * The change notice of a settled surcharge order, as sendOrderConfirmation's `deliver`: reads the
 * order, so the first send and the job's resend are the same mail. The entry is the one the
 * surcharge line names (it follows a package transfer). Throws when nothing certainly went out.
 */
export async function deliverSurchargeChange(admin, orderId) {
  const order = await single(admin.from('orders').select('buyer_email, surcharge_registration_id, surcharge_from_category_id, surcharge_to_category_id, kind').eq('id', orderId).maybeSingle())
  if (!order || order.kind !== 'surcharge') return false
  const line = await single(admin.from('order_lines').select('registration_id').eq('order_id', orderId).eq('kind', 'surcharge').limit(1).maybeSingle())
  return deliverChange(admin, {
    registrationId: line?.registration_id ?? order.surcharge_registration_id,
    fromCategoryId: order.surcharge_from_category_id,
    toCategoryId: order.surcharge_to_category_id,
    surchargeBuyer: order.buyer_email,
  })
}
