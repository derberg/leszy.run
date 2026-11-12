// The organizer panel's model (B3): filters, counts and the actions of one entry, over the rows
// of list-event-registrations. Money is integer grosze.
import { AWAITING_CONSENT, awaitingConsent, filterEntries } from '../../../supabase/functions/_shared/registration/entriesFilter.js'
import { pluralPl } from './plural.js'

// The filter is shared with export-event-registrations, so the CSV holds the rows the panel shows.
export { AWAITING_CONSENT, filterEntries }

const LIVE = new Set(['confirmed', 'pending_payment'])

const isLive = (row) => LIVE.has(row.status) && row.statusKey !== 'expired'

// What is left of the paid lines, reservations counted as gone. Money paid outside the system
// („poza systemem”) never passed through dpay: nothing of it can be refunded there, and it is no
// online income.
const refundable = (row) => (row.paidAmount > 0 && !row.paidOffline
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
 *   dpay's acceptance proves money left. It is online money only: an order paid outside the system
 *   is counts.offlineTotal of list-event-registrations (offlineTile).
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
    clubIncome += refundable(row) + (row.paidAmount > 0 && !row.paidOffline ? (row.refundUnconfirmed ?? 0) : 0)
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
 * @param {{ closed?: boolean, payingClosed?: boolean, raceDay?: boolean, isTeamRow?: boolean, full?: boolean,
 *   isCaptain?: boolean }} [context]
 *   `closed`: at or after closes_at. `payingClosed`: from an hour before closes_at, when online
 *   payment stops and the server refuses a reminder or an extension (`paying_closed`). `raceDay`:
 *   from 00:00 Warsaw on event_date. `full`: the row's competition has no place left, so the
 *   server refuses a payment reminder (`full`, D6-27). `isCaptain`: the row is a team's captain.
 * @returns {string[]} from edit, remind_payment, extend, remind_consent, consent_office, message,
 *   partner (Plan 7: a live person row, never a team row), mark_paid_offline („Opłacone poza
 *   systemem”: an unpaid entry of a paid order, pending or expired, its whole order, until the race
 *   day), offline_note (the note of an order so marked), transfer (Plan 7, ruling 4: a confirmed
 *   adult's own row, a team member's only as captain, until the race day, after close too),
 *   refund, cancel, rename_team, squad
 */
export function entryActions(row, {
  closed = false, payingClosed = closed, raceDay = false, isTeamRow = false, full = false, isCaptain = false,
} = {}) {
  const live = isLive(row)
  const awaitingPayment = row.statusKey === 'awaiting' && !closed && !payingClosed
  const canRefund = !raceDay && row.statusKey !== 'transferred' && refundable(row) > 0
  // Not while a refund of the entry waits for dpay: the RPCs refuse refund_pending (V-87).
  const canTransfer = row.status === 'confirmed' && !raceDay && !isTeamRow && row.role !== 'minor' && (!row.team || isCaptain) && !row.refundPending
  // Unpaid: awaiting payment, or lapsed (statusKey 'expired' with its order still pending or expired).
  // organizer_mark_paid_offline decides; a full competition is its 409, as for a late payment.
  const unpaid = row.statusKey === 'awaiting' || (row.statusKey === 'expired' && (row.status === 'pending_payment' || row.status === 'expired'))
  const canMarkOffline = unpaid && Boolean(row.orderId) && !raceDay
  return [
    ['edit', live && !closed && !isTeamRow],
    ['remind_payment', awaitingPayment && !full],
    ['extend', awaitingPayment],
    ['remind_consent', awaitingConsent(row) && !isTeamRow],
    ['consent_office', awaitingConsent(row) && !isTeamRow],
    ['message', live],
    ['partner', live && !isTeamRow],
    ['mark_paid_offline', canMarkOffline],
    ['offline_note', row.paidOffline === true && row.status === 'confirmed'],
    ['transfer', canTransfer],
    ['refund', canRefund],
    ['cancel', live],
    ['rename_team', live && isTeamRow],
    ['squad', live && isTeamRow],
  ].filter(([, offered]) => offered).map(([action]) => action)
}

/**
 * The value of the „NA LIŚCIE” tile: people and teams each against their own limit, never one
 * sum (Plan 5). With both kinds of competition: „31 / 50 · 2 / 10 DRUŻYN”; with one kind, that one.
 * @param {{ listed: { people: number, teams: number }, capacity: { people: number, teams: number },
 *   perCompetition: { kind: string }[] }} counts  entryCounts'
 */
export function listedTile(counts) {
  const kinds = new Set(counts.perCompetition.map((c) => (c.kind === 'team' ? 'teams' : 'people')))
  const parts = []
  if (kinds.has('people') || kinds.size === 0) parts.push(`${counts.listed.people} / ${counts.capacity.people}`)
  if (kinds.has('teams')) {
    const cap = counts.capacity.teams
    parts.push(`${counts.listed.teams} / ${cap} ${pluralPl(cap, 'DRUŻYNA', 'DRUŻYNY', 'DRUŻYN')}`)
  }
  return parts.join(' · ')
}

/**
 * „ · BRAK MIEJSC” on the „CZEKA NA WPŁATĘ” tile (D6-15): some competition holding an unpaid
 * entry is already full, so that payment would be refunded.
 */
export const noPlacesForAwaiting = (counts) => counts.perCompetition
  .some((c) => c.awaiting > 0 && c.capacity != null && c.listed >= c.capacity)

/**
 * The competition chips: „Wszystkie” and one per visible competition, each with the number of rows
 * it shows; a team competition counts its teams („Sztafeta · 5 drużyn”), never its people. A team
 * counts only while it is live and in `teams` (list-event-registrations' teams, released ones left
 * out); a row outside one (a cancelled member, a released team's people) is a person of its own,
 * „Sztafeta · 1 drużyna · 2 os.”, as the list shows it. Without `teams` every team id counts.
 * @param {object[]} rows
 * @param {object[]} competitions
 * @param {{ id: string }[]} [teams]
 * @returns {{ id: string|null, label: string }[]}
 */
export function competitionChips(rows, competitions, teams = null) {
  const chips = [{ id: null, label: `Wszystkie · ${rows.length}` }]
  const liveTeams = teams ? new Set(teams.map((t) => t.id)) : null
  const inTeam = (row) => (liveTeams ? LIVE.has(row.status) && liveTeams.has(row.team?.id) : row.team?.id != null)
  for (const c of competitions) {
    const own = rows.filter((row) => row.categoryId === c.id)
    if (c.kind === 'team') {
      const n = new Set(own.filter(inTeam).map((row) => row.team.id)).size
      const loose = own.filter((row) => !inTeam(row)).length
      chips.push({ id: c.id, label: `${c.name} · ${n} ${pluralPl(n, 'drużyna', 'drużyny', 'drużyn')}${loose ? ` · ${loose} os.` : ''}` })
    } else {
      chips.push({ id: c.id, label: `${c.name} · ${own.length}` })
    }
  }
  return chips
}

/**
 * The „Partnerzy” chips (Plan 7): „Wszyscy” and one per partner of the event. The number is the
 * server's live count (`partners[].count`: live entries attributed), never the rows a filter shows:
 * a package handed on keeps its partner on the transferred-out row too, and a cancelled entry
 * brought nothing, so counting rows would overstate what a partner brought (9b I-1). None while the
 * event has no partner. `rows` is kept for the call shape; the filter still shows every row.
 * @param {object[]} _rows
 * @param {{ id: string, name: string, count: number }[]} partners list-event-registrations' `partners`
 * @returns {{ id: string|null, label: string }[]}
 */
export function partnerChips(_rows, partners = []) {
  if (!partners.length) return []
  return [{ id: null, label: 'Wszyscy' }, ...partners.map((p) => ({ id: p.id, label: `${p.name} · ${p.count ?? 0}` }))]
}

/**
 * The competitions TransferDialog offers: the row's `transferTo` (list-event-registrations: the
 * same price in its frozen tier), in the event's order. Without that list, its own competition. The
 * own competition is offered even when it is hidden, which `competitions` (the visible ones) leaves
 * out: apply_transfer allows a move within a hidden competition (9b I-2).
 * @param {object} row
 * @param {{ id: string, name: string }[]} competitions the visible ones, in the event's order
 */
export function transferTargets(row, competitions) {
  const ids = new Set(row.transferTo ?? [row.categoryId])
  const shown = competitions.filter((c) => ids.has(c.id))
  const ownHidden = ids.has(row.categoryId) && !competitions.some((c) => c.id === row.categoryId)
  return ownHidden ? [{ id: row.categoryId, name: row.competition }, ...shown] : shown
}

/**
 * TransferDialog's list of people already registered: the recipient was usually told to sign up
 * first, so the organizer picks them instead of typing them in again. Every live entry but the
 * holder's, each with the reason apply_transfer would refuse it (null when it can take the package):
 * a paid one is `duplicate`, an unpaid one sharing its order `pending_elsewhere`, a child
 * `recipient_minor`. An unpaid entry alone in its order is replaced by the package in the same
 * transaction (its order is cancelled). The ones that can be picked come first.
 * @returns {(object & { reason: string|null })[]}
 */
export function transferRecipients(rows, holder) {
  const live = rows.filter((r) => LIVE.has(r.status) && r.id !== holder.id)
  const perOrder = new Map()
  for (const r of rows) {
    if (r.orderId && LIVE.has(r.status)) perOrder.set(r.orderId, (perOrder.get(r.orderId) ?? 0) + 1)
  }
  const reasonOf = (r) => {
    if (r.status === 'confirmed') return 'Opłacone'
    if (r.role === 'minor') return 'Dziecko'
    if (r.team) return 'Drużyna'
    if (r.orderId && (perOrder.get(r.orderId) ?? 0) > 1) return 'W zamówieniu grupowym'
    return null
  }
  const out = live.map((r) => ({ ...r, reason: reasonOf(r) }))
  return [...out.filter((r) => !r.reason), ...out.filter((r) => r.reason)]
}

/** The PersonForm value of a picked entry: the server validates it as if typed. */
export function transferPersonFrom(r) {
  const keys = ['firstName', 'lastName', 'birthDate', 'gender', 'email', 'phone', 'city', 'club', 'iceName', 'icePhone', 'nationality']
  return Object.fromEntries(keys.map((k) => [k, r[k] ?? '']))
}

/**
 * The status chips, each counting the rows its filter shows. „Poza systemem” only while some entry
 * was paid outside the system, „Do wycofania w pomiarze” only while somebody is to be withdrawn.
 * @returns {{ key: string|null, label: string }[]}
 */
export function statusChips(counts) {
  const n = (key) => counts.byStatus[key] ?? 0
  return [
    { key: null, label: 'Wszystkie' },
    { key: 'paid', label: `Opłacone · ${n('paid')}` },
    ...(n('paid_offline') > 0 ? [{ key: 'paid_offline', label: `Poza systemem · ${n('paid_offline')}` }] : []),
    { key: 'awaiting', label: `Czeka na wpłatę · ${n('awaiting')}` },
    ...(n('withdraw_on_host') > 0 ? [{ key: 'withdraw_on_host', label: `Do wycofania w pomiarze · ${n('withdraw_on_host')}` }] : []),
    { key: AWAITING_CONSENT, label: `Czeka na zgody · ${counts.awaitingConsent}` },
    { key: 'expired', label: `Wygasłe · ${n('expired')}` },
    { key: 'cancelled', label: `Anulowane · ${n('cancelled')}` },
  ]
}

/**
 * The ⋯ label of an action from entryActions. A team row writes to its captain; an unpaid entry's
 * cancel is „Anuluj nieopłacone zgłoszenie” (D6-16): it cancels the whole order and refunds nothing.
 * Cancelling a captain cancels the team (cancel_registration), so on the team row and on the
 * captain's own row it reads „Anuluj drużynę”.
 */
export function actionLabel(action, row, { isTeamRow = false, isCaptain = false } = {}) {
  switch (action) {
    case 'edit': return 'Edytuj dane'
    case 'remind_payment': return 'Przypomnij o wpłacie'
    case 'extend': return 'Przedłuż termin wpłaty'
    // A child's row waits for the parent the captain named (mark-consent-office records it as paper).
    case 'remind_consent': return row.role === 'minor' ? 'Przypomnij opiekunowi o zgodzie' : 'Przypomnij o akceptacji regulaminu'
    case 'consent_office': return row.role === 'minor' ? 'Zgoda opiekuna na papierze' : 'Regulamin podpisany w biurze'
    case 'message': return isTeamRow ? 'Napisz do kapitana' : 'Napisz do zawodnika'
    case 'refund': return 'Zwróć wpłatę'
    case 'cancel':
      if (isTeamRow || isCaptain) return 'Anuluj drużynę'
      return row.statusKey === 'awaiting' ? 'Anuluj nieopłacone zgłoszenie' : 'Anuluj zgłoszenie'
    case 'rename_team': return 'Zmień nazwę drużyny'
    case 'squad': return 'Skład drużyny'
    case 'partner': return 'Partner'
    case 'transfer': return 'Przekaż pakiet'
    case 'mark_paid_offline': return 'Opłacone poza systemem'
    case 'offline_note': return 'Notatka o wpłacie'
    default: throw new Error(`unknown action: ${action}`)
  }
}

const DAY = 86_400_000
// extend_order_window takes up to now() + 14 days on the server's clock; the dialog stays 10 min
// under it, so a browser clock a little ahead of the server's is not refused.
const CLOCK_MARGIN = 10 * 60_000

/**
 * The three choices → [{ id, label, until: Date|null }]; `until` null when that choice cannot
 * move the deadline forward, or lands where an earlier choice already does.
 * @param {{ expiresAt: string|null, closesAt: string|null, now?: Date }} o
 */
export function extendChoices({ expiresAt, closesAt, now = new Date() }) {
  const closes = closesAt ? new Date(closesAt) : null
  const current = expiresAt ? new Date(expiresAt) : now
  const limit = new Date(now.getTime() + 14 * DAY - CLOCK_MARGIN)
  const cap = (d) => {
    const capped = d > limit ? limit : d
    return closes && capped > closes ? closes : capped
  }
  const usable = (d) => (d && d > current && d <= limit ? d : null)
  const choices = [
    { id: '7', label: '+ 7 dni', until: usable(cap(new Date(current.getTime() + 7 * DAY))) },
    { id: '14', label: '+ 14 dni', until: usable(cap(new Date(current.getTime() + 14 * DAY))) },
    { id: 'close', label: 'Do końca zapisów', until: usable(closes) },
  ]
  let latest = null
  for (const c of choices) {
    if (c.until && latest && c.until <= latest) c.until = null
    if (c.until) latest = c.until
  }
  return choices
}

/**
 * The line under „WPŁYWY DLA KLUBU”: money the organizer took outside LESZY.RUN, never added to the
 * tile's online income. „poza systemem: 200,00 zł (1 zgłoszenie)”, null when there is none.
 * @param {{ offlineTotal?: number, offlineOrders?: number }} counts list-event-registrations' counts
 * @param {(grosze: number) => string} formatPln
 */
export function offlineIncomeNote(counts, formatPln) {
  const n = counts?.offlineOrders ?? 0
  if (!(n > 0)) return null
  return `poza systemem: ${formatPln(counts.offlineTotal ?? 0)} (${n} ${pluralPl(n, 'zgłoszenie', 'zgłoszenia', 'zgłoszeń')})`
}
