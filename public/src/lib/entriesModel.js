// The organizer panel's model (B3): filters, counts and the actions of one entry, over the rows
// of list-event-registrations. Money is integer grosze.
import { AWAITING_CONSENT, awaitingConsent, filterEntries } from '../../../supabase/functions/_shared/registration/entriesFilter.js'

// The filter is shared with export-event-registrations, so the CSV holds the rows the panel shows.
export { AWAITING_CONSENT, filterEntries }

const LIVE = new Set(['confirmed', 'pending_payment'])

const isLive = (row) => LIVE.has(row.status) && row.statusKey !== 'expired'

// What is left of the paid lines, reservations counted as gone.
const refundable = (row) => (row.paidAmount > 0
  ? (row.lines ?? []).reduce((sum, line) => sum + line.amount - line.refunded, 0)
  : 0)

/**
 * @param {object[]} rows every row of the event, unfiltered
 * @param {{ id: string, name: string, kind: string, capacity: number }[]} competitions the visible ones
 * @returns {{ listed: { people: number, teams: number }, capacity: { people: number, teams: number },
 *   awaiting: number, awaitingConsent: number, expired: number, cancelled: number, clubIncome: number,
 *   byStatus: Record<string, number>,
 *   perCompetition: { id: string, name: string, kind: string, capacity: number, listed: number, awaiting: number }[] }}
 *   `listed` equals `taken`: confirmed entries, a team once. People and teams are never added into
 *   one number (Plan 5): `listed` and `capacity` keep the individual competitions (`people`) and
 *   the team competitions (`teams`, whose limit counts teams) apart. `awaiting` is people, and
 *   stays outside `listed` and the limit (P3-R15). `clubIncome` keeps an unconfirmed refund: only
 *   dpay's acceptance proves money left.
 */
export function entryCounts(rows, competitions) {
  const byStatus = {}
  const slots = new Map()
  const awaitingIn = new Map()
  let clubIncome = 0
  for (const row of rows) {
    byStatus[row.statusKey] = (byStatus[row.statusKey] ?? 0) + 1
    if (row.status === 'confirmed') {
      if (!slots.has(row.categoryId)) slots.set(row.categoryId, new Set())
      slots.get(row.categoryId).add(row.team?.id ?? row.id)
    }
    if (row.statusKey === 'awaiting') awaitingIn.set(row.categoryId, (awaitingIn.get(row.categoryId) ?? 0) + 1)
    clubIncome += refundable(row) + (row.paidAmount > 0 ? (row.refundUnconfirmed ?? 0) : 0)
  }
  const listed = { people: 0, teams: 0 }
  const capacity = { people: 0, teams: 0 }
  for (const c of competitions) {
    const unit = c.kind === 'team' ? 'teams' : 'people'
    listed[unit] += slots.get(c.id)?.size ?? 0
    capacity[unit] += c.capacity ?? 0
  }
  return {
    listed,
    capacity,
    awaiting: byStatus.awaiting ?? 0,
    awaitingConsent: rows.filter(awaitingConsent).length,
    // By status, so a cancelled row shown as withdraw_on_host or refund_unconfirmed still counts.
    expired: rows.filter((row) => row.status === 'expired' || row.statusKey === 'expired').length,
    cancelled: rows.filter((row) => row.status === 'cancelled').length,
    clubIncome,
    byStatus,
    perCompetition: competitions.map(({ id, name, kind, capacity }) => ({
      id, name, kind, capacity, listed: slots.get(id)?.size ?? 0, awaiting: awaitingIn.get(id) ?? 0,
    })),
  }
}

/**
 * What the row's ⋯ menu offers, in menu order. A team row stands for the team: its people have
 * their own rows, which hold `edit` and the consent controls.
 * @param {object} row
 * @param {{ closed?: boolean, raceDay?: boolean, isTeamRow?: boolean }} [context]
 *   `closed`: at or after closes_at. `raceDay`: from 00:00 Warsaw on event_date.
 * @returns {string[]} from edit, remind_payment, extend, remind_consent, consent_office, message,
 *   refund, cancel, rename_team, squad
 */
export function entryActions(row, { closed = false, raceDay = false, isTeamRow = false } = {}) {
  const live = isLive(row)
  const awaitingPayment = row.statusKey === 'awaiting' && !closed
  const canRefund = !raceDay && row.statusKey !== 'transferred' && refundable(row) > 0
  return [
    ['edit', live && !closed && !isTeamRow],
    ['remind_payment', awaitingPayment],
    ['extend', awaitingPayment],
    ['remind_consent', awaitingConsent(row) && !isTeamRow],
    ['consent_office', awaitingConsent(row) && !isTeamRow],
    ['message', live],
    ['refund', canRefund],
    ['cancel', live],
    ['rename_team', live && isTeamRow],
    ['squad', live && isTeamRow],
  ].filter(([, offered]) => offered).map(([action]) => action)
}
