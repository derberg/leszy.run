// Group registration RPC helpers for the LOCAL stack (plan 4, task 2). A group is
// one request: every person carries their own categoryId and role ('self' | 'adult' |
// 'minor'), and p_meta carries the buyer's name for the minors' guardian fields.
import { consentIds, person, profileFor, rpc, runnerEmail } from './orders.js'
import { paymentFee, supportFee } from '../../../supabase/functions/_shared/registration/money.js'

export const BIEG = (capacity = 50) =>
  ({ name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity })
export const DZIECI = (capacity = 50) =>
  ({ name: 'Bieg dzieci 1 km', discipline: 'run', distanceLabel: '1 km', startTime: '09:00', capacity })

/** An adult in the group: 'self' (the buyer runs) or 'adult' (another grown-up). */
export const adult = (categoryId, role, email = runnerEmail(role), over = {}) =>
  ({ categoryId, role, ...person(email, over) })

/** A child: no email, covered by the buyer's guardian consent. */
export const minor = (categoryId, over = {}) => ({
  categoryId, role: 'minor', firstName: 'Zosia', lastName: 'Leśna', birthDate: '2016-05-05', gender: 'K',
  phone: '+48500100200', ageGroupLabel: 'K dzieci', ...over,
})

export async function groupMeta(eventId, over = {}) {
  return { buyerName: 'Ola Leśna', consentIds: await consentIds(eventId), ip: '203.0.113.9', userAgent: 'test', ...over }
}

const buyerOf = (people, buyerEmail) =>
  buyerEmail ?? people.find((p) => p.role === 'self')?.email ?? runnerEmail('buyer')

/** The new register_free(p_people, p_profile_id, p_meta). */
export async function registerGroup(event, people, { buyerEmail, profileId, meta } = {}) {
  const profile = profileId === undefined ? await profileFor(buyerOf(people, buyerEmail)) : profileId
  return rpc('register_free', {
    p_people: people, p_profile_id: profile, p_meta: meta ?? await groupMeta(event.eventId),
  })
}

/** The checkout total for a group: each person at their own competition's price. */
export function groupTotal(event, people, support = false) {
  const entry = people.reduce((sum, p) => sum + event.prices[p.categoryId], 0)
  const s = entry > 0 ? supportFee(entry, support) : 0
  return entry + s + paymentFee(entry + s)
}

/** The new create_order(p_people, p_profile_id, p_buyer_email, p_support_choice, p_displayed_total, p_meta). */
export async function orderGroup(event, people, { buyerEmail, profileId, support = false, displayed, meta } = {}) {
  const buyer = buyerOf(people, buyerEmail)
  const profile = profileId === undefined ? await profileFor(buyer) : profileId
  return rpc('create_order', {
    p_people: people, p_profile_id: profile, p_buyer_email: buyer, p_support_choice: support,
    p_displayed_total: displayed ?? groupTotal(event, people, support),
    p_meta: meta ?? await groupMeta(event.eventId),
  })
}

export async function orderGroupOk(event, people, opts) {
  const r = await orderGroup(event, people, opts)
  if (r.error) throw new Error(`create_order (group): ${r.error.message}`)
  return r.data
}

export const isDeadlock = (r) => r?.error?.code === '40P01' || /deadlock/i.test(r?.error?.message ?? '')
