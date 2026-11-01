// Team RPC helpers for the LOCAL stack (plan 5, task 3). A team is one create_team_registration
// call: member 0 is the captain, role 'self', and every member comes as group.js hands them over.
import crypto from 'node:crypto'
import { createPublishedFreeEvent, createPublishedPaidEvent } from './registrationFixtures.js'
import { db, person, profileFor, rpc, runnerEmail } from './orders.js'
import { adult, groupMeta, minor } from './groups.js'

export const STAFETA = (capacity = 50, over = {}) => ({
  name: 'Sztafeta', discipline: 'run', distanceLabel: '4 x 5 km', startTime: '10:00', capacity,
  kind: 'team', teamMin: 2, teamMax: 6, ...over,
})

export const teamName = () => `Wilcze Stado ${crypto.randomBytes(4).toString('hex')}`

export async function freeTeamEvent(owner, { capacity = 50, legOrder = false, competitions, ...options } = {}) {
  const event = await createPublishedFreeEvent(owner, { competitions: competitions ?? [STAFETA(capacity)], ...options })
  if (legOrder) await setLegOrder(event.categoryIds[0])
  return event
}

export async function paidTeamEvent(owner, { capacity = 50, price = 24000, legOrder = false, competitions, prices, ...options } = {}) {
  const event = await createPublishedPaidEvent(owner, {
    competitions: competitions ?? [STAFETA(capacity)], prices: prices ?? { Sztafeta: price }, ...options,
  })
  if (legOrder) await setLegOrder(event.categoryIds[0])
  return event
}

export async function setLegOrder(categoryId, on = true) {
  const { error } = await db().from('competitions').update({ leg_order_enabled: on }).eq('category_id', categoryId)
  if (error) throw error
}

export const captain = (email = runnerEmail('captain'), over = {}) => ({ role: 'self', ...person(email, over) })

/** The T-20 squad: the captain, one adult, two children. */
export const squad = (cat) => [
  captain(), adult(cat, 'adult'),
  minor(cat, { firstName: `Zosia${crypto.randomBytes(3).toString('hex')}` }),
  minor(cat, { firstName: `Staś${crypto.randomBytes(3).toString('hex')}`, gender: 'M' }),
]

/** create_team_registration for the event's first competition. `displayed` defaults to the right total. */
export async function createTeam(event, {
  categoryId = event.categoryIds[0], name = teamName(), members, profileId, buyerEmail, displayed, meta,
} = {}) {
  const list = members ?? squad(categoryId)
  const buyer = buyerEmail ?? list[0]?.email
  return rpc('create_team_registration', {
    p_category_id: categoryId,
    p_team_name: name,
    p_members: list,
    p_profile_id: profileId === undefined ? await profileFor(buyer) : profileId,
    p_buyer_email: buyer,
    p_displayed_total: displayed ?? event.prices?.[categoryId] ?? 0,
    p_meta: meta ?? await groupMeta(event.eventId),
  })
}

export async function teamOk(event, opts) {
  const r = await createTeam(event, opts)
  if (r.error) throw new Error(`create_team_registration: ${r.error.message}`)
  return r.data
}

/** team_squad_edit, as the captain unless `actor` says otherwise. `meta` defaults to the event's consents. */
export async function squadEdit(event, teamId, actor, op, meta) {
  return rpc('team_squad_edit', {
    p_team_id: teamId, p_actor_profile_id: actor, p_op: op, p_meta: meta ?? await groupMeta(event.eventId),
  })
}
