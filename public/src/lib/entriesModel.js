// The organizer panel's model (B3): filters, counts and the actions of one entry, over the rows
// of list-event-registrations. Money is integer grosze.
import { foldPl } from './startList.js'

/** „Czeka na zgody” in the status filter: a state of the consent, not an entry status. */
export const AWAITING_CONSENT = 'awaiting_consent'

const LIVE = new Set(['confirmed', 'pending_payment'])

const awaitingConsent = (row) => row.status === 'confirmed' && row.consentState === 'awaiting'
const isLive = (row) => LIVE.has(row.status) && row.statusKey !== 'expired'

function matches(row, needle) {
  return [row.name, row.email, row.team?.name, row.bib].some((value) => foldPl(value).includes(needle))
}

/**
 * @param {object[]} rows
 * @param {{ categoryId?: string, statusKey?: string, q?: string, partnerId?: string }} [filters]
 *   `q` looks in the name, e-mail, team name and bib, ignoring case and diacritics
 */
export function filterEntries(rows, { categoryId, statusKey, q, partnerId } = {}) {
  const needle = foldPl(q)
  return rows.filter((row) => {
    if (categoryId && row.categoryId !== categoryId) return false
    if (partnerId && row.partnerId !== partnerId) return false
    if (statusKey === AWAITING_CONSENT) {
      if (!awaitingConsent(row)) return false
    } else if (statusKey && row.statusKey !== statusKey) return false
    return !needle || matches(row, needle)
  })
}

// What is left of the paid lines, reservations counted as gone.
const refundable = (row) => (row.paidAmount > 0
  ? (row.lines ?? []).reduce((sum, line) => sum + line.amount - line.refunded, 0)
  : 0)

/**
 * @param {object[]} rows every row of the event, unfiltered
 * @param {{ id: string, name: string, kind: string, capacity: number }[]} competitions the visible ones
 * @returns {{ listed: number, capacity: number, awaiting: number, awaitingConsent: number,
 *   expired: number, cancelled: number, clubIncome: number, byStatus: Record<string, number>,
 *   perCompetition: { id: string, name: string, kind: string, capacity: number, listed: number, awaiting: number }[] }}
 *   `listed` equals `taken`: confirmed entries, a team once. `awaiting` is people, and stays outside
 *   `listed` and the limit (P3-R15). `clubIncome` keeps an unconfirmed refund: only dpay's
 *   acceptance proves money left.
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
  let listed = 0
  for (const units of slots.values()) listed += units.size
  return {
    listed,
    capacity: competitions.reduce((sum, c) => sum + c.capacity, 0),
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
