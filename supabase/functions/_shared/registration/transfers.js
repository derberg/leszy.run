// Package transfers on the edge (Plan 7, task 7): what transfer-invite, transfer-accept,
// my-event-registrations and organizer-entry-action share. Runs on the admin (service role)
// client. The transfer token never passes through here: only its SHA-256 (tokens.js) is read, and
// nothing here logs an address.
import { sendEmail } from '../email.js'
import { ageOn } from './ageGroups.js'
import { warsawToday } from './dates.js'
import { ADULT_AGE } from './person.js'

async function rows(query) {
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export const GONE = 'Ten link został już użyty, cofnięty albo wygasł.'
export const TRY_AGAIN = 'Nie udało się przekazać pakietu. Spróbuj ponownie.'

/**
 * Every refusal the transfer RPCs raise (20261103150000) → [status, text]. A code missing here
 * would be a 500, so the functions look every message up in this one table.
 */
export const TRANSFER_REFUSALS = {
  not_found: [404, 'Not found'],
  not_owner: [404, 'Not found'],
  not_transferable: [409, 'Tego pakietu nie można przekazać.'],
  transfer_off: [409, 'Przekazanie pakietu nie jest już możliwe.'],
  same_person: [409, 'To jest adres osoby, która ma ten pakiet.'],
  pending_exists: [409, 'Zaproszenie już wysłane. Cofnij je, aby wysłać nowe.'],
  invalid_email: [400, 'Podaj poprawny adres e-mail.'],
  invalid_token: [400, GONE],
  gone: [409, GONE],
  recipient_minor: [409, 'Pakiet może przejąć tylko osoba pełnoletnia.'],
  price_differs: [409, 'Wybierz konkurencję w tej samej cenie.'],
  duplicate: [409, 'Masz już opłacony start na tych zawodach.'],
  pending_elsewhere: [409, 'Masz nieopłacone zgłoszenie na te zawody razem z innymi osobami. Opłać je albo poproś o anulowanie.'],
  team_competition: [409, 'Pakiet drużyny zostaje w jej konkurencji.'],
  unavailable: [409, 'Ta konkurencja nie jest już dostępna.'],
  consents_required: [400, 'Zaznacz wymagane zgody.'],
  consents_changed: [400, 'Zaznacz wymagane zgody.'],
  profile_mismatch: [403, 'Zaloguj się adresem e-mail, który podajesz.'],
  invalid_person: [400, 'Popraw zaznaczone pola.'],
  invalid_kind: [400, TRY_AGAIN],
  race_day: [409, 'W dniu zawodów pakiet przekazuje się w biurze zawodów.'],
  transfer_retry: [409, TRY_AGAIN],
}

/** The SQLSTATE of transfer_retry: the recipient opened an order between the RPC's read and its locks. */
export const isRetry = (error) => error?.code === '40001' || error?.message === 'transfer_retry'

/**
 * Calls a transfer RPC, once more when it answers transfer_retry (40001), which apply_transfer
 * leaves to its caller. PostgREST may already have retried it; either way nothing was written by a
 * call that failed, and no e-mail goes out before a call returns without error.
 */
export async function callTransferRpc(admin, fn, args) {
  let res = await admin.rpc(fn, args)
  if (res.error && isRetry(res.error)) res = await admin.rpc(fn, args)
  return res
}

/**
 * Claims one e-mail of a transfer (20261103160000): true when this call stamped the column, false
 * when somebody already had. Claim, then send: at most once.
 */
export async function claimTransferEmail(admin, transferId, column) {
  const { data, error } = await admin.from('transfers').update({ [column]: new Date().toISOString() })
    .eq('id', transferId).is(column, null).select('id')
  if (error) throw error
  return (data ?? []).length === 1
}

/**
 * Claims, then sends. Never throws: the transfer stands whether or not the e-mail goes out, and a
 * failure is logged by the transfer's id, never by the address. → true when handed to the sender.
 */
export async function sendTransferEmail(admin, transferId, column, to, mail) {
  if (!to || !mail) return false
  try {
    if (!await claimTransferEmail(admin, transferId, column)) return false
    const res = await sendEmail({ to, ...mail })
    if (res && res.ok === false) throw new Error(`e-mail not accepted (${res.status})`)
    return true
  } catch (err) {
    console.error(`transfer ${transferId}: ${column} not sent:`, err?.message)
    return false
  }
}

/**
 * May the holder hand this entry on now (ruling 3, §5.4)? The rule create_transfer applies: their
 * own confirmed adult entry (18 on the race day), not a child's, a team member's only as captain,
 * while transfers are on and the Warsaw day is not past transfer_until. `team` is the entry's team
 * row ({ captain_registration_id }) or null.
 */
export function transferAllowed(reg, settings, userId, { team = null, now = new Date() } = {}) {
  if (!reg || !settings || !userId) return false
  if (reg.profile_id !== userId || reg.status !== 'confirmed') return false
  if (!reg.email || reg.guardian_profile_id || !reg.birth_date) return false
  if (ageOn(reg.birth_date, settings.event_date, 'race_day') < ADULT_AGE) return false
  if (reg.team_id && team?.captain_registration_id !== reg.id) return false
  if (!settings.transfer_enabled || !settings.transfer_until) return false
  return warsawToday(now) <= settings.transfer_until
}

/**
 * The transfer block of each of `regs` for the session `userId`:
 * → Map(id → { allowed, until, pending: { transferId, toEmail, createdAt, expiresAt } | null }).
 * `pending` is the holder's own open invite only, and an invite past expires_at is not pending,
 * whatever its status says (create_transfer marks those expired only on the next invite). The
 * address is the one the holder typed; nobody else is shown it.
 * `regs` carry id, profile_id, status, email, guardian_profile_id, birth_date, team_id.
 */
export async function transferViews(admin, regs, settings, userId, { now = new Date() } = {}) {
  const mine = regs.filter((r) => r.profile_id && r.profile_id === userId)
  const teamIds = [...new Set(mine.map((r) => r.team_id).filter(Boolean))]
  const [pending, teams] = await Promise.all([
    mine.length
      ? rows(admin.from('transfers').select('id, registration_id, to_email, created_at, expires_at')
        .in('registration_id', mine.map((r) => r.id)).eq('status', 'pending').gt('expires_at', now.toISOString()))
      : [],
    teamIds.length ? rows(admin.from('teams').select('id, captain_registration_id').in('id', teamIds)) : [],
  ])
  const pendingOf = new Map(pending.map((t) => [t.registration_id, t]))
  const teamOf = new Map(teams.map((t) => [t.id, t]))
  const until = settings?.transfer_enabled ? settings?.transfer_until ?? null : null
  return new Map(regs.map((r) => {
    const isMine = Boolean(r.profile_id) && r.profile_id === userId
    const t = isMine ? pendingOf.get(r.id) : null
    return [r.id, {
      allowed: isMine && transferAllowed(r, settings, userId, { team: teamOf.get(r.team_id) ?? null, now }),
      until,
      pending: t ? { transferId: t.id, toEmail: t.to_email, createdAt: t.created_at, expiresAt: t.expires_at } : null,
    }]
  }))
}

/**
 * The registrations among `ids` that a package transfer created → Set of ids (accepted transfers
 * of either kind). An order line pointing at one of them is a transferred line (carry T7 b).
 */
export async function transferredRegistrationIds(admin, ids) {
  const list = [...new Set((ids ?? []).filter(Boolean))]
  if (!list.length) return new Set()
  const found = await rows(admin.from('transfers').select('new_registration_id')
    .in('new_registration_id', list).eq('status', 'accepted'))
  return new Set(found.map((t) => t.new_registration_id))
}
