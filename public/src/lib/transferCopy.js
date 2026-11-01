// The runner's transfer pages (Plan 7): RA5's action, RA6 (the holder, transfer-invite) and RA7
// (the recipient, transfer-accept). Every refusal those functions can give has its own Polish line
// here, keyed by `code`, so nothing reaches the page as the English „Not found” or a bare 500.
// Imported by relative path (not @registration) so node --test can load it too.
import { RETIRED_EMAIL_MESSAGE } from '../../../supabase/functions/_shared/deletedEmails.js'

export const OFFLINE = 'Nie udało się połączyć. Spróbuj ponownie.'
const TRY_AGAIN = 'Nie udało się. Spróbuj ponownie.'
const NOT_FOUND = 'Nie znaleźliśmy tego zgłoszenia.'
export const GONE = 'Ten link został już użyty, cofnięty albo wygasł.'

/** code → the line the page shows. The server's own wording where it has one (TRANSFER_REFUSALS). */
export const TRANSFER_MESSAGES = Object.freeze({
  not_found: NOT_FOUND,
  not_owner: NOT_FOUND,
  not_transferable: 'Tego pakietu nie można przekazać.',
  transfer_off: 'Przekazanie pakietu nie jest już możliwe.',
  same_person: 'To jest adres osoby, która ma ten pakiet.',
  pending_exists: 'Zaproszenie już wysłane. Cofnij je, aby wysłać nowe.',
  invalid_email: 'Podaj poprawny adres e-mail.',
  invalid_token: GONE,
  gone: GONE,
  recipient_minor: 'Pakiet może przejąć tylko osoba pełnoletnia.',
  price_differs: 'Wybierz konkurencję w tej samej cenie.',
  duplicate: 'Masz już opłacony start na tych zawodach.',
  pending_elsewhere: 'Masz nieopłacone zgłoszenie na te zawody razem z innymi osobami. Opłać je albo poproś o anulowanie.',
  team_competition: 'Pakiet drużyny zostaje w jej konkurencji.',
  unavailable: 'Ta konkurencja nie jest już dostępna.',
  consents_required: 'Zaznacz wymagane zgody.',
  consents_changed: 'Zaznacz wymagane zgody.',
  profile_mismatch: 'Zaloguj się adresem e-mail, który podajesz.',
  invalid_person: 'Popraw zaznaczone pola.',
  invalid_kind: 'Nie udało się przekazać pakietu. Spróbuj ponownie.',
  race_day: 'W dniu zawodów pakiet przekazuje się w biurze zawodów.',
  transfer_retry: 'Nie udało się przekazać pakietu. Spróbuj ponownie.',
  throttled: 'Zbyt wiele prób. Spróbuj ponownie później.',
  expired: 'To zaproszenie już wygasło. Link nie działa.',
  not_pending: 'Zaproszenia nie można już cofnąć: zostało przyjęte, cofnięte albo wygasło.',
  code_required: 'Wpisz kod wysłany na adres e-mail.',
  email_retired: RETIRED_EMAIL_MESSAGE,
  invalid_action: TRY_AGAIN,
})

// The code's own refusals (verifyCode: „Nieprawidłowy kod.”, „Kod wygasł…”) carry no `code` and
// are Polish: kept. Anything without a Polish letter is a server's English text and is replaced.
const POLISH_LETTER = /[ąćęłńóśźż]/i

function messageOf(err, { unauthorized, throttled }) {
  if (!err || err.status == null) return OFFLINE
  if (err.code === 'throttled') return throttled
  if (err.code && TRANSFER_MESSAGES[err.code]) return TRANSFER_MESSAGES[err.code]
  if (err.status === 401 && !POLISH_LETTER.test(err.message ?? '')) return unauthorized
  if (err.status === 404) return NOT_FOUND
  if (err.status === 429) return throttled
  if ([400, 401, 403].includes(err.status) && POLISH_LETTER.test(err.message ?? '')) return err.message
  return TRY_AGAIN
}

/** RA6: transfer-invite's refusal as the page shows it. */
export const inviteError = (err) => messageOf(err, {
  unauthorized: 'Zaloguj się ponownie, żeby przekazać pakiet.',
  throttled: 'Zbyt wiele zaproszeń. Spróbuj ponownie jutro.',
})

/** RA7: transfer-accept's refusal as the page shows it. */
export const acceptError = (err) => messageOf(err, {
  unauthorized: TRANSFER_MESSAGES.code_required,
  throttled: TRANSFER_MESSAGES.throttled,
})

/** RA7: refusals that end the link for this tab (nothing on the form can change them). */
export const ENDS_LINK = new Set(['gone', 'invalid_token', 'transfer_off', 'race_day'])

/**
 * RA5: the row's „Przekaż pakiet innej osobie →”, only where my-event-registrations says the session
 * may hand this entry on now (its own adult entry or a team's as captain, transfers on, today ≤ the
 * organizer's last day; ruling 3). → { href, label, pending } | null
 */
export function transferAction(row, slug) {
  if (row?.transfer?.allowed !== true) return null
  const to = row.transfer.pending?.toEmail
  return { href: `/events/${slug}/przekaz/${row.id}`, label: 'Przekaż pakiet innej osobie →', pending: to ? `Czeka na ${to}` : null }
}

/** RA6: „MOŻLIWE DO d.mm · BEZ OPŁATY” from transfer_until (a Warsaw day, YYYY-MM-DD). */
export function untilLabel(iso) {
  const [, m, d] = String(iso ?? '').split('-').map(Number)
  if (!m || !d) return null
  return `MOŻLIWE DO ${d}.${String(m).padStart(2, '0')} · BEZ OPŁATY`
}

const shortPln = (label) => String(label ?? '').replace(/,00 zł$/, ' zł')

/** RA7: the competition select's label, with the package's price („60,00 zł” → „60 zł”). */
export const samePriceLabel = (priceLabel) => `Konkurencja · w tej samej cenie (${shortPln(priceLabel)})`

/** RA7 after closes_at: the link still works. A 0 zł package was never paid, so it does not say so. */
export function closedBadge({ registrationClosed, priceLabel }) {
  if (!registrationClosed) return null
  return shortPln(priceLabel) === '0 zł' ? 'ZAPISY ZAMKNIĘTE, ALE TEN LINK DZIAŁA' : 'PAKIET OPŁACONY · ZAPISY ZAMKNIĘTE, ALE TEN LINK DZIAŁA'
}

export const DUE_LABEL = 'Do zapłaty: 0 zł.'
export const MONEY_NOTE = 'Pieniądze za pakiet rozliczacie między sobą, poza LESZY.RUN. Nie zwracamy ich ani nie przekazujemy.'
