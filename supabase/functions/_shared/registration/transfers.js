// Package transfers on the edge (Plan 7, task 7): what transfer-invite, transfer-accept,
// my-event-registrations and organizer-entry-action share. Runs on the admin (service role)
// client. The transfer token never passes through here: only its SHA-256 (tokens.js) is read, and
// nothing here logs an address.
import { sendEmail } from '../email.js'
import { ageOn } from './ageGroups.js'
import { warsawToday } from './dates.js'
import { ADULT_AGE } from './person.js'
import { eventPageUrl } from './slug.js'
import { transferAcceptedEmail, transferByOrganizerEmail, transferConfirmationEmail } from './transferEmails.js'

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

// organizer_transfer's refusals (Plan 7, ruling 4), worded for the organizer where the runner's copy
// would say „you”. A runner's 400 is a 422 here, the panel's contract for a refused value.
const ORGANIZER_TRANSFER_REFUSALS = {
  ...Object.fromEntries(Object.entries(TRANSFER_REFUSALS).map(([k, [status, text]]) => [k, [status === 400 ? 422 : status, text]])),
  gone: [409, 'To zgłoszenie nie jest już aktywne.'],
  duplicate: [409, 'Ta osoba jest już zapisana na te zawody.'],
  pending_elsewhere: [409, 'Ta osoba ma nieopłacone zgłoszenie na te zawody razem z innymi osobami.'],
  same_person: [409, 'To jest osoba, która ma ten pakiet.'],
  recipient_minor: [409, 'Pakiet może przejąć tylko osoba pełnoletnia.'],
  invalid_person: [422, 'Popraw zaznaczone pola.'],
}

// The field a 422 is about. Every 422 of organizer-entry-action carries `fields` (Plan 6's
// contract), an empty set when the RPC names none.
const ORGANIZER_TRANSFER_FIELDS = { invalid_email: 'email' }

/**
 * organizer-entry-action `transfer`'s answer to an RPC refusal → { status, body } or null for an
 * unknown code (the caller throws: a 500).
 */
export function organizerTransferRefusal(code) {
  const known = ORGANIZER_TRANSFER_REFUSALS[code]
  if (!known) return null
  const [status, error] = known
  if (status !== 422) return { status, body: { error, code } }
  const field = ORGANIZER_TRANSFER_FIELDS[code]
  return { status, body: { error, code, fields: field ? { [field]: error } : {} } }
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
 * An operator alert naming the transfer and the column only (no address, no token), once per pair.
 * Never throws.
 */
export async function transferAlert(admin, kind, transferId, column) {
  try {
    const { error } = await admin.from('operator_alerts').upsert(
      { kind, order_id: null, payload: { transferId, column }, dedupe_key: `${kind}:${transferId}:${column}` },
      { onConflict: 'dedupe_key', ignoreDuplicates: true })
    if (error) console.error(`operator alert ${kind} not stored:`, error.message)
  } catch (err) {
    console.error(`operator alert ${kind} not stored:`, err?.message)
  }
}

/**
 * Claims, then sends: Plan 3's rule (sendOrderConfirmation). Never throws: the transfer stands
 * whether or not the e-mail goes out, and a failure is logged by the transfer's id, never by the
 * address. → true when handed to the sender.
 *   - a send that certainly failed (an error before it, or the sender's non-2xx answer) gives the
 *     claim back, so registration-jobs can send it again (resendTransferEmails);
 *   - a send whose fate is unknown (`deliveryUnknown`: SendGrid's timeout or a broken connection)
 *     keeps the claim and raises `transfer_email_unknown`: a second copy is worse than one the
 *     operator re-sends by hand;
 *   - `claimed: true` (the job's own re-send, claimed already) never gives the claim back: a
 *     failure raises `transfer_email_failed` and nothing retries it again.
 * `send` is for the unit tests.
 */
export async function sendTransferEmail(admin, transferId, column, to, mail, { claimed = false, send = sendEmail } = {}) {
  if (!to || !mail) return false
  let mine = claimed
  try {
    if (!claimed) {
      if (!await claimTransferEmail(admin, transferId, column)) return false
      mine = true
    }
    const res = await send({ to, ...mail })
    if (res && res.ok === false) throw new Error(`e-mail not accepted (${res.status})`)
    return true
  } catch (err) {
    console.error(`transfer ${transferId}: ${column} not sent:`, err?.message)
    if (claimed) {
      await transferAlert(admin, 'transfer_email_failed', transferId, column)
    } else if (mine && err?.deliveryUnknown) {
      await transferAlert(admin, 'transfer_email_unknown', transferId, column)
    } else if (mine) {
      try {
        const { error } = await admin.from('transfers').update({ [column]: null }).eq('id', transferId)
        if (error) throw error
      } catch (e) {
        console.error(`transfer ${transferId}: ${column} claim not released:`, e?.message)
      }
    }
    return false
  }
}

const eventFacts = (settings) => ({
  name: settings.name,
  eventDate: settings.event_date,
  place: [settings.town_label, settings.place_details].filter(Boolean).join(', ') || null,
})

async function one(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

/**
 * The e-mail a column of an ACCEPTED transfer stands for, built from the stored rows, so the
 * first send and the job's re-send are the same e-mail → { to, mail } or null (nobody to send to:
 * the sender deleted the account, or the row is not that kind of transfer).
 *   accepted_emailed_at      → the sender, „Pakiet przejęła <Imię Nazwisko>” (runner transfers)
 *   confirmation_emailed_at  → the recipient, „Jesteś na liście” (runner transfers)
 *   holder_emailed_at        → the old holder, „Pakiet przekazany” (organizer transfers; never names the recipient, N-1)
 */
export async function buildTransferMail(admin, transfer, column) {
  const t = transfer.new_registration_id && transfer.kind
    ? transfer
    : await one(admin.from('transfers').select('id, kind, status, event_id, registration_id, new_registration_id').eq('id', transfer.id).single())
  if (t.status !== 'accepted' || !t.new_registration_id) return null
  const want = { accepted_emailed_at: 'runner', confirmation_emailed_at: 'runner', holder_emailed_at: 'organizer' }[column]
  if (!want || t.kind !== want) return null
  const cols = 'id, category_id, first_name, last_name, email, age_group_label'
  const [oldReg, newReg, settings] = await Promise.all([
    one(admin.from('registrations').select(cols).eq('id', t.registration_id).single()),
    one(admin.from('registrations').select(cols).eq('id', t.new_registration_id).single()),
    one(admin.from('registration_settings')
      .select('event_id, name, slug, event_date, first_start_time, town_label, place_details, club_id, contact_email')
      .eq('event_id', t.event_id).single()),
  ])
  const event = eventFacts(settings)
  const recipient = { firstName: newReg.first_name, lastName: newReg.last_name }
  if (column === 'accepted_emailed_at') {
    return oldReg.email ? { to: oldReg.email, mail: transferAcceptedEmail({ event, senderFirstName: oldReg.first_name, recipient }) } : null
  }
  if (column === 'holder_emailed_at') {
    if (!oldReg.email) return null
    const club = settings.club_id ? await one(admin.from('clubs').select('name').eq('id', settings.club_id).maybeSingle()) : null
    return {
      to: oldReg.email,
      // Ruling N-1: the recipient is not passed, so it cannot reach the old holder.
      mail: transferByOrganizerEmail({
        event, holderFirstName: oldReg.first_name,
        organizer: { name: club?.name?.trim() || null, contactEmail: settings.contact_email ?? null },
      }),
    }
  }
  const comp = await one(admin.from('competitions').select('name, start_time').eq('category_id', newReg.category_id).maybeSingle())
  return newReg.email
    ? {
      to: newReg.email,
      mail: transferConfirmationEmail({
        event: { ...event, url: eventPageUrl(settings.slug) },
        person: { firstName: newReg.first_name, ageGroupLabel: newReg.age_group_label },
        competition: { name: comp?.name ?? null, startTime: (comp?.start_time ?? settings.first_start_time)?.slice(0, 5) ?? null },
      }),
    }
    : null
}

/**
 * Builds and sends one column's e-mail of an accepted transfer (first send). Never throws.
 */
export async function sendAcceptedTransferEmail(admin, transfer, column) {
  try {
    const built = await buildTransferMail(admin, transfer, column)
    if (!built) return false
    return await sendTransferEmail(admin, transfer.id, column, built.to, built.mail)
  } catch (err) {
    console.error(`transfer ${transfer.id}: ${column} not built:`, err?.message)
    return false
  }
}

const RESEND_AFTER_MS = 10 * 60_000
const RESEND_WINDOW_MS = 7 * 86_400_000
const RESEND_COLUMNS = [['accepted_emailed_at', 'runner'], ['confirmation_emailed_at', 'runner'], ['holder_emailed_at', 'organizer']]

/**
 * registration-jobs' sweep: an accepted transfer whose e-mail column is still NULL 10 minutes
 * after acceptance (the first send certainly failed and gave its claim back, or the function died
 * between the RPC and the claim) gets it once: claimed here first, so a failure raises
 * `transfer_email_failed` and is never retried again. Accepted in the last 7 days only.
 * The invite (its token lives only in the request that made it) and the cancel e-mail (an invite
 * cancelled by cancel_registration or organizer_transfer looks the same as one the holder took
 * back) are not re-sent. → the number of e-mails handed to the sender.
 */
export async function resendTransferEmails(admin, { limit = 50, now = Date.now() } = {}) {
  let sent = 0
  for (const [column, kind] of RESEND_COLUMNS) {
    const due = await rows(admin.from('transfers')
      .select('id, kind, status, event_id, registration_id, new_registration_id')
      .eq('kind', kind).eq('status', 'accepted').is(column, null)
      .lte('accepted_at', new Date(now - RESEND_AFTER_MS).toISOString())
      .gt('accepted_at', new Date(now - RESEND_WINDOW_MS).toISOString())
      .order('accepted_at').limit(limit))
    for (const t of due) {
      if (!await claimTransferEmail(admin, t.id, column)) continue
      try {
        const built = await buildTransferMail(admin, t, column)
        if (built && await sendTransferEmail(admin, t.id, column, built.to, built.mail, { claimed: true })) sent++
      } catch (err) {
        console.error(`transfer ${t.id}: ${column} re-send failed:`, err?.message)
        await transferAlert(admin, 'transfer_email_failed', t.id, column)
      }
    }
  }
  return sent
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
