// The paid registration e-mails. Pure: every input is passed in, nothing is read from the
// runtime, so the same module runs in the edge functions and in node:test. Amounts are
// integer grosze, shown only through formatPln. No e-mail mentions a bib: numbers are
// assigned later, by the organizer. The confirmation is the payment confirmation, not a
// fiscal receipt: the entry fees are collected on the organizer's behalf.
import { formatPln } from './money.js'

const TZ = 'Europe/Warsaw'
const dayFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** '2026-11-28' → '28.11.2026' (a calendar date, no time zone involved). */
export function isoDay(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

/** An instant in Warsaw time: '29.10.2026, 11:15'. */
function warsawDateTime(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${dayFmt.format(d)}, ${timeFmt.format(d)}`
}

export const textBlock = (pairs) => pairs.map(([k, v]) => `${k}: ${v}`)
export const htmlBlock = (pairs) => `<p>${pairs.map(([k, v]) => `${escapeHtml(k)}: <strong>${escapeHtml(v)}</strong>`).join('<br>')}</p>`
export const link = (url, label) => `<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`

function personLines(lines) {
  return lines.map((l) => {
    const name = `${l.firstName ?? ''} ${l.lastName ?? ''}`.trim()
    // A line whose package was handed on (Plan 7): the holder's name only, nothing else of theirs;
    // after an organizer transfer not even that (ruling N-1).
    if (l.transferred && (l.transferredBy === 'organizer' || !name)) return 'Pakiet przekazany przez organizatora'
    if (l.transferred) return `${name} — przejął(-ęła) pakiet`
    const facts = [l.competition, l.ageGroupLabel ? `kategoria ${l.ageGroupLabel}` : null, l.startTime ? `start ${l.startTime}` : null]
      .filter(Boolean).join(', ')
    return `${name} — ${facts}`
  })
}

// What every paid confirmation states about the money, an order's and a team's alike. An order the
// organizer marked „opłacone poza systemem” passed through no dpay transaction and no LESZY.RUN
// account: it says only the amount and that it is settled with the organizer.
function paymentFacts(order, organizer) {
  if (order.paidOffline) {
    return {
      amounts: [['Razem', formatPln(order.total)]],
      payment: [['Płatność', `u organizatora (${organizer.name})`]],
      note: null,
    }
  }
  return {
    amounts: [
      [`Opłaty startowe (pobrane w imieniu i na rzecz Organizatora: ${organizer.name})`, formatPln(order.entryTotal)],
      ['Razem', formatPln(order.total)],
    ],
    payment: [
      ...(order.paidTransactionId ? [['Transakcja dpay', order.paidTransactionId]] : []),
      ...(warsawDateTime(order.paidAt) ? [['Data płatności', warsawDateTime(order.paidAt)]] : []),
    ],
    note: 'To potwierdzenie płatności, nie jest paragonem ani fakturą.',
  }
}

/**
 * The payment confirmation. event { name, slug?, eventDate?, place? }, order { id, entryTotal,
 * total, paidTransactionId, paidAt, paidOffline? }, lines [{ firstName, lastName,
 * competition, ageGroupLabel, startTime }], organizer { name }, orderUrl (optional: the order page).
 * A 0 zł order paid nothing, so it is a registration confirmation (P3-R9): „Zapis potwierdzony”,
 * no payment wording and no amount lines. An order marked „opłacone poza systemem” (paidOffline) is
 * a registration confirmation too, „potwierdzone przez organizatora”, with its total and „Płatność: u
 * organizatora”: no dpay transaction, never a claim that LESZY.RUN collected the money.
 */
export function orderConfirmationEmail({ event, order, lines, organizer, orderUrl = null }) {
  const people = personLines(lines)
  const when = [isoDay(event.eventDate), event.place].filter(Boolean).join(', ')
  const whenText = when ? ` (${when})` : ''
  const free = order.total === 0
  const { amounts, payment, note } = free ? { amounts: [], payment: [], note: null } : paymentFacts(order, organizer)
  // Paid outside the system: the organizer confirmed the entry, no online payment is claimed.
  const offline = !free && order.paidOffline === true
  const lead = (name) => (free || offline
    ? `Twoje zgłoszenie na zawody ${name}${whenText} zostało potwierdzone${offline ? ' przez organizatora' : ''}.`
    : `płatność za zgłoszenie na zawody ${name}${whenText} została przyjęta.`)
  const leadHtml = free || offline
    ? `Twoje zgłoszenie na zawody <strong>${escapeHtml(event.name)}</strong>${escapeHtml(whenText)} zostało potwierdzone${offline ? ' przez organizatora' : ''}.`
    : `płatność za zgłoszenie na zawody <strong>${escapeHtml(event.name)}</strong>${escapeHtml(whenText)} została przyjęta.`

  const text = [
    'Cześć,',
    '',
    lead(event.name),
    '',
    'Zgłoszone osoby:',
    ...people.map((p) => `- ${p}`),
    ...(amounts.length ? ['', ...textBlock(amounts)] : []),
    ...(payment.length ? ['', ...textBlock(payment)] : []),
    ...(note ? ['', note] : []),
    ...(orderUrl ? ['', `Twoje zgłoszenie: ${orderUrl}`] : []),
    '',
    'LESZY.RUN',
  ].join('\n')

  const html = [
    '<p>Cześć,</p>',
    `<p>${leadHtml}</p>`,
    '<p>Zgłoszone osoby:</p>',
    `<ul>${people.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`,
    amounts.length ? htmlBlock(amounts) : '',
    payment.length ? htmlBlock(payment) : '',
    note ? `<p>${escapeHtml(note)}</p>` : '',
    orderUrl ? link(orderUrl, 'Twoje zgłoszenie') : '',
    '<p>LESZY.RUN</p>',
  ].join('')

  return { subject: `${free || offline ? 'Zapis potwierdzony' : 'Opłacone'} — ${event.name}`, text, html }
}

/**
 * The order is still unpaid: pay link and the moment it expires. An unpaid entry holds no place
 * (P3-R15): the paid entries fill the limit, so the runner is told that, never that a place waits.
 */
export function paymentReminderEmail({ event, order, payUrl }) {
  const until = warsawDateTime(order.expiresAt)
  const expiry = until ? `Bez wpłaty do ${until} zgłoszenie wygaśnie.` : 'Bez wpłaty w terminie zgłoszenie wygaśnie.'
  const placeNote = 'Miejsce zajmuje dopiero opłacone zgłoszenie — jeśli inne osoby opłacą wcześniej wszystkie miejsca, nie będzie można go już opłacić.'
  const facts = [['Do zapłaty', formatPln(order.total)], ...(until ? [['Termin', until]] : [])]
  const text = [
    'Cześć,',
    '',
    `Twoje zgłoszenie na zawody ${event.name} czeka na wpłatę. ${placeNote} ${expiry}`,
    '',
    ...textBlock(facts),
    '',
    `Zapłać: ${payUrl}`,
    '',
    'LESZY.RUN',
  ].join('\n')
  const html = [
    '<p>Cześć,</p>',
    `<p>Twoje zgłoszenie na zawody <strong>${escapeHtml(event.name)}</strong> czeka na wpłatę. ${escapeHtml(placeNote)} ${escapeHtml(expiry)}</p>`,
    htmlBlock(facts),
    link(payUrl, 'Zapłać'),
    '<p>LESZY.RUN</p>',
  ].join('')
  return { subject: `Zgłoszenie czeka na wpłatę — ${event.name}`, text, html }
}

/**
 * The payment window passed without a payment. The order never held a place (P3-R15), so nothing is
 * said about one; places may still be free, so the runner is pointed back to the sign-up.
 */
const AGAIN_NOTE = 'Jeśli są jeszcze wolne miejsca, możesz zapisać się ponownie i od razu opłacić zgłoszenie.'

export function orderExpiredEmail({ event, order, eventUrl }) {
  const text = [
    'Cześć,',
    '',
    `Twoje zgłoszenie na zawody ${event.name} wygasło, bo nie zostało opłacone w terminie (${formatPln(order.total)}).`,
    '',
    AGAIN_NOTE,
    '',
    `Zapisz się ponownie: ${eventUrl}`,
    '',
    'LESZY.RUN',
  ].join('\n')
  const html = [
    '<p>Cześć,</p>',
    `<p>Twoje zgłoszenie na zawody <strong>${escapeHtml(event.name)}</strong> wygasło, bo nie zostało opłacone w terminie (${escapeHtml(formatPln(order.total))}).</p>`,
    `<p>${escapeHtml(AGAIN_NOTE)}</p>`,
    link(eventUrl, 'Zapisz się ponownie'),
    '<p>LESZY.RUN</p>',
  ].join('')
  return { subject: `Zgłoszenie wygasło — ${event.name}`, text, html }
}

// 'late' and 'double' are the two kinds; the late kinds also take confirm_order's own reason
// (refunds.reason) for a sentence that says what actually happened.
const REFUND_REASONS = {
  late: 'Płatność dotarła, gdy zgłoszenie nie mogło już zostać przyjęte.',
  double: 'Zgłoszenie było już opłacone, a ta płatność była kolejną.',
  double_payment: 'Zgłoszenie było już opłacone, a ta płatność była kolejną.',
  closed: 'Płatność dotarła po zamknięciu zapisów.',
  // P3-R15: the limit counts paid entries only, so the last place may go to whoever pays first.
  full: 'Zanim płatność dotarła, inne osoby opłaciły ostatnie wolne miejsca. Limit miejsc liczy tylko opłacone zgłoszenia.',
  duplicate: 'Płatność dotarła po wygaśnięciu zgłoszenia, a ten adres e-mail został w tym czasie zapisany ponownie.',
  cancelled: 'Płatność dotarła po anulowaniu zgłoszenia.',
  unavailable: 'Płatność dotarła, gdy zapisy na tę konkurencję nie były już prowadzone.',
  // D7-20: an expired order's late payment could not take its code or its extras again (ruling 8).
  voucher: 'Płatność dotarła po wygaśnięciu zgłoszenia, a Twój kod rabatowy został w tym czasie wykorzystany.',
  stock: 'Płatność dotarła po wygaśnięciu zgłoszenia, a wybrany dodatek został w tym czasie wyprzedany.',
}

/** A payment refunded in full: reason 'late', 'double', or confirm_order's refund reason. */
export function paymentRefundedEmail({ event, order, amount, reason }) {
  const why = REFUND_REASONS[reason]
  if (!why) throw new Error(`unknown refund reason: ${reason}`)
  const facts = [['Kwota zwrotu', formatPln(amount)], ...(order?.id ? [['Zgłoszenie', order.id]] : [])]
  const text = [
    'Cześć,',
    '',
    `zwracamy Twoją płatność za zawody ${event.name} w całości. ${why}`,
    '',
    ...textBlock(facts),
    '',
    'Pieniądze wrócą tą samą drogą, którą zostały wysłane, zwykle w ciągu kilku dni roboczych.',
    '',
    'LESZY.RUN',
  ].join('\n')
  const html = [
    '<p>Cześć,</p>',
    `<p>zwracamy Twoją płatność za zawody <strong>${escapeHtml(event.name)}</strong> w całości. ${escapeHtml(why)}</p>`,
    htmlBlock(facts),
    '<p>Pieniądze wrócą tą samą drogą, którą zostały wysłane, zwykle w ciągu kilku dni roboczych.</p>',
    '<p>LESZY.RUN</p>',
  ].join('')
  return { subject: `Płatność zwrócona — ${event.name}`, text, html }
}

/**
 * An organizer's refund (Plan 6), sent as the club: plain text only, like every organizer message
 * (spec 12.10). event { name }, person { firstName, lastName } (the entry, null names for a deleted
 * account), grosze (this refund), cancelled (the refund cancelled the entry), organizer { name }.
 */
export function organizerRefundEmail({ event, person, grosze, cancelled, organizer, paidByOther = false }) {
  const amount = formatPln(grosze)
  const who = [person?.firstName, person?.lastName].filter(Boolean).join(' ')
  const entry = who ? `zgłoszenia: ${who}` : 'zgłoszenia'
  const text = [
    'Cześć,',
    '',
    `organizator zawodów ${event.name}, ${organizer.name}, zwrócił ${amount} z opłaty za ${entry}.`,
    ...(cancelled ? ['', 'Zgłoszenie zostało anulowane.'] : []),
    '',
    // A package taken over from somebody else (Plan 7): the money goes back to whoever paid.
    paidByOther
      ? 'Zwrot trafia do osoby, która zapłaciła za to zgłoszenie.'
      : 'Pieniądze wrócą tą samą drogą, którą zostały wysłane, zwykle w ciągu kilku dni roboczych.',
    'Pytania o zwrot kieruj do organizatora: wystarczy odpowiedzieć na tę wiadomość.',
    '',
    organizer.name,
  ].join('\n')
  return { subject: `Zwrot ${amount} — ${event.name}`, text }
}

const RESOLVE = 'backend/scripts/resolve-registration-refund.js --refund <refundId> --outcome accepted|rejected --note "…"'

/**
 * What the operator does about an alert kind, one line each, for the kinds Plan 6's organizer
 * refunds raise (the runbook in backend/scripts/resolve-registration-refund.js says the same).
 * An automatic refund's stalled or unknown alert keeps Plan 3's manual handling: the kinds in
 * ORGANIZER_ONLY_HINTS are raised for both, so their hint is shown only when an alert of that kind
 * carries payload.reason 'organizer' (Task 5 review M1).
 */
export const ALERT_HINTS = {
  refund_unknown: `zwrot organizatora bez pewnej odpowiedzi dpay (z polem verify: dpay odpowiedział 400, a /pbl/details nie rozstrzygnął; dpayRefunded to suma zwrotów w dpay, recorded nasza): sprawdź panel dpay, potem ${RESOLVE}`,
  refund_pending: `zwrot organizatora zapisany przez starszą wersję jako „w toku” (dpay 409): sprawdź panel dpay, potem ${RESOLVE}`,
  refund_blocked: 'dpay odpowiedział 409 „Transaction already has a refund form submitted!”: stary formularz zwrotu blokuje zwroty tej transakcji przez API i sam nie zniknie. Pieniądze nie wyszły, zwrot zapisany jako odrzucony. Napisz do dpay z identyfikatorem transakcji (txn). Zwrot organizatora (reason organizer): po odblokowaniu organizator zleca go ponownie. Zwrot automatyczny (double_payment, late_refund): nikt go nie ponowi, po odblokowaniu zwróć kwotę grosze ręcznie w panelu dpay',
  refund_stalled: `zwrot bez odpowiedzi dpay od 15 min. Organizatora (reason organizer): sprawdź panel dpay, potem ${RESOLVE}`,
  refund_never_sent: `zwrot nigdy nie wysłany do dpay. Organizatora (reason organizer): brak zwrotu w panelu dpay → ${RESOLVE} z --outcome rejected`,
  refund_email_failed: 'zwrot przyjęty, e-mail do biegacza nie wyszedł: popraw przyczynę lub napisz ręcznie; refunds.runner_notified_at = NULL każe zadaniu wysłać go ponownie. Z polem copy (payer / holder) nie wyszła tylko ta kopia, druga doszła: napisz do tej osoby ręcznie i nie zeruj runner_notified_at',
  refund_email_unknown: 'zwrot przyjęty, e-mail mógł wyjść (timeout): sprawdź SendGrid; tylko gdy nie doszedł, refunds.runner_notified_at = NULL (z polem copy nigdy: napisz ręcznie)',
  refund_followup_failed: 'zwrot zapisany, nie powiódł się wpis audytu lub e-mail po nim: pieniędzy to nie dotyczy; e-mail wyśle zadanie, gdy runner_notified_at jest puste',
  refund_cancel_failed: 'zwrot przyjęty, zgłoszenia nie udało się anulować: anuluj je ręcznie w panelu organizatora',
  refund_email_args_failed: 'zadanie nie odczytało danych do e-maila o zwrocie (błąd bazy): sprawdź wiersz refunds i jego order_line_id; zadanie próbuje co 15 min',
  refund_external: 'dpay pokazuje zwrot, którego leszy.run nie zapisał (zwrot zrobiony w panelu dpay, nie przez „Zwróć wpłatę”); difference w groszach: sprawdź transakcję txn w panelu dpay, potem backend/scripts/record-external-refund.js --order <orderId> --amount <zł> --note "…" (bez --apply to podgląd; --notify wysyła biegaczowi e-mail o zwrocie)',
  external_refund_check_failed: 'zadanie nie odczytało w dpay kwoty zwrotów (refunded_amount) części opłaconych zamówień, więc zwrot zrobiony w panelu dpay mógł zostać niezauważony: sprawdź dostęp do dpay i logi registration-jobs; zamówienia są sprawdzane ponownie następnego dnia',
  refund_insufficient_balance: 'zwrot organizatora odrzucony, saldo dpay za niskie: rezerwacja zwolniona, organizator może zlecić zwrot ponownie po zasileniu konta (nikt go nie ponawia)',
}

const ORGANIZER_ONLY_HINTS = new Set(['refund_unknown', 'refund_pending', 'refund_insufficient_balance'])

/** Operator digest of operator_alerts rows: [{ kind, orderId, payload, createdAt }]. */
export function operatorAlertEmail({ alerts }) {
  const kinds = [...new Set(alerts.map((a) => a.kind))]
  const entries = alerts.map((a) => [
    `${warsawDateTime(a.createdAt) ?? a.createdAt ?? ''} ${a.kind}`.trim(),
    `zamówienie ${a.orderId ?? '—'}`,
    a.payload ? JSON.stringify(a.payload) : '',
  ].filter(Boolean).join(' · '))
  const hinted = (k) => ALERT_HINTS[k] && (!ORGANIZER_ONLY_HINTS.has(k)
    || alerts.some((a) => a.kind === k && a.payload?.reason === 'organizer'))
  const hints = kinds.filter(hinted).map((k) => `${k}: ${ALERT_HINTS[k]}`)
  const text = [
    `Płatności wymagają sprawdzenia (${alerts.length}):`,
    '',
    ...entries.map((e) => `- ${e}`),
    ...(hints.length ? ['', 'Co zrobić:', ...hints.map((h) => `- ${h}`)] : []),
    '',
    'Sprawdź panel dpay przed jakimkolwiek ręcznym zwrotem.',
  ].join('\n')
  const html = [
    `<p>Płatności wymagają sprawdzenia (${alerts.length}):</p>`,
    `<ul>${entries.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`,
    ...(hints.length ? ['<p>Co zrobić:</p>', `<ul>${hints.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>`] : []),
    '<p>Sprawdź panel dpay przed jakimkolwiek ręcznym zwrotem.</p>',
  ].join('')
  return { subject: `[ALERT] Płatności: ${kinds.join(', ')}`, text, html }
}

// ---------------------------------------------------------------- free sign-up and consent requests (Plan 4)

const fullName = (p) => `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim()

function officeLines(officeHours = []) {
  return officeHours.map((h) => `${dayFmt.format(new Date(h.starts_at))} ${timeFmt.format(new Date(h.starts_at))}–${timeFmt.format(new Date(h.ends_at))}${h.note ? ` (${h.note})` : ''}`)
}

/**
 * The free registration confirmation, one e-mail to whoever registered (Plan 2's „Jesteś na
 * liście”, moved here from register-free). event { name, eventDate, place, officePlace, url },
 * people [{ role: self|adult|minor, firstName, lastName, competition, ageGroupLabel, startTime }],
 * payerFirstName, officeHours [{ starts_at, ends_at, note }].
 *   one person who is the payer      → „Jesteś na liście — <nazwa>”, Plan 2's text unchanged
 *   more than one person             → „Jesteście na liście — <nazwa>”, every person listed
 *   one other person (payer does not run) → „<Imię Nazwisko> jest na liście — <nazwa>”
 * An added adult is told they will get the regulamin to accept. No bib is ever mentioned.
 */
export function freeConfirmationEmail({ event, people, payerFirstName, officeHours = [] }) {
  const office = officeLines(officeHours)
  const officeText = office.length
    ? ['', `Biuro zawodów${event.officePlace ? ` (${event.officePlace})` : ''}:`, ...office.map((o) => `- ${o}`)]
    : []
  const officeHtml = office.length
    ? `<p>Biuro zawodów${event.officePlace ? ` (${escapeHtml(event.officePlace)})` : ''}:</p><ul>${office.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ul>`
    : ''
  const day = isoDay(event.eventDate)
  const footerText = ['', `Strona zawodów: ${event.url}`, '', 'LESZY.RUN']
  const footerHtml = [link(event.url, 'Strona zawodów'), '<p>LESZY.RUN</p>']

  if (people.length === 1 && people[0].role === 'self') {
    const person = people[0]
    const facts = [
      ['Konkurencja', person.competition],
      ['Kategoria', person.ageGroupLabel],
      ['Start', day ? `${day}${person.startTime ? `, godz. ${person.startTime}` : ''}` : null],
      ['Miejsce', event.place],
    ].filter(([, v]) => v)
    const text = [
      `Cześć ${person.firstName},`,
      '',
      `jesteś na liście startowej zawodów ${event.name}.`,
      '',
      ...textBlock(facts),
      ...officeText,
      ...footerText,
    ].join('\n')
    const html = [
      `<p>Cześć ${escapeHtml(person.firstName)},</p>`,
      `<p>jesteś na liście startowej zawodów <strong>${escapeHtml(event.name)}</strong>.</p>`,
      htmlBlock(facts),
      officeHtml,
      ...footerHtml,
    ].join('')
    return { subject: `Jesteś na liście — ${event.name}`, text, html }
  }

  const lines = personLines(people)
  const awaiting = people.filter((p) => p.role === 'adult').map(fullName)
  const awaitingNote = awaiting.map((n) => `${n} dostanie osobny e-mail z prośbą o akceptację regulaminu.`)
  const facts = [['Data', day], ['Miejsce', event.place]].filter(([, v]) => v)
  const subject = people.length > 1
    ? `Jesteście na liście — ${event.name}`
    : `${fullName(people[0])} jest na liście — ${event.name}`
  const lead = people.length > 1 ? 'zgłoszone osoby są na liście startowej zawodów' : 'zgłoszona osoba jest na liście startowej zawodów'
  const greeting = payerFirstName ? `Cześć ${payerFirstName},` : 'Cześć,'
  const text = [
    greeting,
    '',
    `${lead} ${event.name}.`,
    '',
    ...lines.map((l) => `- ${l}`),
    ...(facts.length ? ['', ...textBlock(facts)] : []),
    ...(awaitingNote.length ? ['', ...awaitingNote] : []),
    ...officeText,
    ...footerText,
  ].join('\n')
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(lead)} <strong>${escapeHtml(event.name)}</strong>.</p>`,
    `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
    facts.length ? htmlBlock(facts) : '',
    awaitingNote.length ? `<p>${awaitingNote.map(escapeHtml).join('<br>')}</p>` : '',
    officeHtml,
    ...footerHtml,
  ].join('')
  return { subject, text, html }
}

/**
 * The consent request to an adult somebody else registered (ruling 10: the Art. 14 notice,
 * the data did not come from them). event { name, eventDate, place? }, person { firstName },
 * registeredBy (who provided the data), competition { name, startTime }, link (the consent
 * page, `/zgoda#<token>`), dataInfoUrl (the runner data information). `reminder: true` prefixes
 * the subject with „Przypomnienie: ”. team { name } (optional) adds „w drużynie <nazwa>”.
 * `detailsOwed` (a team member, memberDetails.js): the captain left out a field the event requires,
 * so the data note says what the captain gave and the link asks for the rest. `guardian` (a child
 * whose parent is not the captain, consentRecipient): the e-mail goes to that parent and asks for
 * the child's participation instead (guardianConsentEmail). The link is the only place the token appears.
 */
export function consentRequestEmail({
  event, person, registeredBy, competition, link: url, dataInfoUrl, reminder = false, team = null, detailsOwed = false, guardian = null,
}) {
  if (guardian) return guardianConsentEmail({ event, person, registeredBy, competition, link: url, dataInfoUrl, reminder, team })
  const day = isoDay(event.eventDate)
  const start = [day, competition?.startTime ? `godz. ${competition.startTime}` : null].filter(Boolean).join(', ')
  const facts = [
    ['Konkurencja', competition?.name],
    ['Start', start || null],
    ['Miejsce', event.place],
  ].filter(([, v]) => v)
  // Nobody named: „Inna osoba” opens a sentence, „inna osoba” sits inside one.
  const who = registeredBy || 'Inna osoba'
  const whoInside = registeredBy || 'inna osoba'
  const office = 'Jeśli nie zaakceptujesz online, podpiszesz regulamin w biurze zawodów.'
  const dataNote = detailsOwed
    ? `Twoje imię, nazwisko, datę urodzenia, płeć, e-mail i ewentualnie inne pola zgłoszenia podał(a) ${whoInside}. Brakujące dane, np. telefon, uzupełnisz sam(a) pod linkiem. Kto przetwarza Twoje dane, w jakim celu i jakie masz prawa:`
    : `Twoje dane (imię, nazwisko, datę urodzenia, płeć, e-mail, telefon i pozostałe pola zgłoszenia) podał(a) ${whoInside}. Kto je przetwarza, w jakim celu i jakie masz prawa:`
  const action = detailsOwed ? 'Uzupełnij dane i zaakceptuj regulamin' : 'Zaakceptuj regulamin'
  const greeting = person?.firstName ? `Cześć ${person.firstName},` : 'Cześć,'
  const inTeam = team?.name ? ` w drużynie ${team.name}` : ''
  const text = [
    greeting,
    '',
    `${who} zapisał(a) Cię na zawody ${event.name}${inTeam}.`,
    '',
    ...textBlock(facts),
    '',
    `${action}: ${url}`,
    '',
    office,
    '',
    dataNote,
    dataInfoUrl,
    '',
    'LESZY.RUN',
  ].join('\n')
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(who)} zapisał(a) Cię na zawody <strong>${escapeHtml(event.name)}</strong>${escapeHtml(inTeam)}.</p>`,
    htmlBlock(facts),
    link(url, action),
    `<p>${escapeHtml(office)}</p>`,
    `<p>${escapeHtml(dataNote)} <a href="${escapeHtml(dataInfoUrl)}">${escapeHtml(dataInfoUrl)}</a></p>`,
    '<p>LESZY.RUN</p>',
  ].join('')
  const subject = `Zapisano Cię na ${event.name} — ${detailsOwed ? 'uzupełnij dane i ' : ''}zaakceptuj regulamin`
  // The link carries the token in its fragment: no click-tracking redirect may rewrite it.
  return { subject: reminder ? `Przypomnienie: ${subject}` : subject, text, html, noTracking: true }
}

/**
 * consentRequestEmail for a child's parent or guardian, whom the captain named on the team form: who
 * entered the child, where, and the link to accept the child's participation. The data note is
 * the Art. 14 notice for both the child's data and the parent's own name and address, which the
 * captain gave. `person` is the child (first name only).
 */
function guardianConsentEmail({ event, person, registeredBy, competition, link: url, dataInfoUrl, reminder, team }) {
  const day = isoDay(event.eventDate)
  const start = [day, competition?.startTime ? `godz. ${competition.startTime}` : null].filter(Boolean).join(', ')
  const facts = [
    ['Konkurencja', competition?.name],
    ['Start', start || null],
    ['Miejsce', event.place],
  ].filter(([, v]) => v)
  const who = registeredBy || 'Inna osoba'
  const child = person?.firstName ? `Twoje dziecko, ${person.firstName},` : 'Twoje dziecko'
  const inTeam = team?.name ? ` w drużynie ${team.name}` : ''
  const ask = 'Jako rodzic lub opiekun prawny zdecyduj, czy dziecko wystartuje: pod linkiem sprawdzisz i poprawisz jego dane i zaakceptujesz regulamin.'
  const action = 'Zaakceptuj udział dziecka'
  const office = 'Jeśli nie zaakceptujesz online, zgodę podpiszesz w biurze zawodów.'
  const dataNote = `${who} podał(a) dane dziecka (imię, nazwisko, datę urodzenia, płeć i pozostałe pola zgłoszenia) oraz Twoje imię, nazwisko i adres e-mail. Kto je przetwarza, w jakim celu i jakie masz prawa:`
  const text = [
    'Dzień dobry,',
    '',
    `${who} zapisał(a) ${child} na zawody ${event.name}${inTeam}.`,
    '',
    ...textBlock(facts),
    '',
    ask,
    '',
    `${action}: ${url}`,
    '',
    office,
    '',
    dataNote,
    dataInfoUrl,
    '',
    'LESZY.RUN',
  ].join('\n')
  const html = [
    '<p>Dzień dobry,</p>',
    `<p>${escapeHtml(who)} zapisał(a) ${escapeHtml(child)} na zawody <strong>${escapeHtml(event.name)}</strong>${escapeHtml(inTeam)}.</p>`,
    htmlBlock(facts),
    `<p>${escapeHtml(ask)}</p>`,
    link(url, action),
    `<p>${escapeHtml(office)}</p>`,
    `<p>${escapeHtml(dataNote)} <a href="${escapeHtml(dataInfoUrl)}">${escapeHtml(dataInfoUrl)}</a></p>`,
    '<p>LESZY.RUN</p>',
  ].join('')
  const subject = `Zapisano dziecko na ${event.name} — zaakceptuj udział dziecka`
  // The link carries the token in its fragment: no click-tracking redirect may rewrite it.
  return { subject: reminder ? `Przypomnienie: ${subject}` : subject, text, html, noTracking: true }
}

// ---------------------------------------------------------------- teams (Plan 5)

const PARENT_ASKED = 'Rodzic lub opiekun, którego dane podano przy dziecku, dostanie e-mail z prośbą o zgodę na udział dziecka.'

function memberLine(m) {
  const facts = [
    m.ageGroupLabel ? `kategoria ${m.ageGroupLabel}` : null,
    m.role === 'self' ? 'kapitan' : null,
    // A child whose parent is not the captain (parentName) waits for that parent's consent.
    m.role === 'minor' ? (m.parentName ? `opiekun: ${m.parentName}${m.consentState === 'awaiting' ? ' (czeka na zgodę)' : ''}` : 'opiekun: kapitan') : null,
    m.transferred ? 'przejął(-ęła) pakiet' : null,
  ].filter(Boolean).join(', ')
  return facts ? `${fullName(m)} — ${facts}` : fullName(m)
}

/**
 * The team confirmation, to the captain. event { name, eventDate?, place? }, team { name,
 * competition }, members [{ firstName, lastName, role: self|adult|minor, ageGroupLabel, parentName?,
 * consentState? }] (parentName: a child's parent who is not the captain), link
 * (the squad page). `paid` is { order, organizer, orderUrl } for a fee that was paid, which makes
 * this the payment confirmation as well; a free team and a 0 zł fee pass null (P3-R9). No bib and
 * no leg numbers.
 */
export function teamConfirmationEmail({ event, team, members, link: url, paid = null }) {
  const lines = members.map(memberLine)
  const facts = [['Konkurencja', team.competition], ['Data', isoDay(event.eventDate)], ['Miejsce', event.place]].filter(([, v]) => v)
  const { amounts, payment, note } = paid ? paymentFacts(paid.order, paid.organizer) : { amounts: [], payment: [], note: null }
  const orderUrl = paid?.orderUrl ?? null
  const awaiting = [
    members.some((m) => m.role === 'adult') ? 'Każdy dorosły członek drużyny dostanie osobny e-mail z prośbą o akceptację regulaminu.' : null,
    members.some((m) => m.role === 'minor' && m.parentName && m.consentState === 'awaiting') ? PARENT_ASKED : null,
  ].filter(Boolean).join(' ') || null
  const lead = 'jest na liście startowej zawodów'
  const text = [
    'Cześć,',
    '',
    `drużyna ${team.name} ${lead} ${event.name}.`,
    '',
    ...textBlock(facts),
    '',
    'Skład:',
    ...lines.map((l) => `- ${l}`),
    ...(awaiting ? ['', awaiting] : []),
    ...(amounts.length ? ['', ...textBlock(amounts)] : []),
    ...(payment.length ? ['', ...textBlock(payment)] : []),
    ...(note ? ['', note] : []),
    '',
    `Zarządzaj składem: ${url}`,
    ...(orderUrl ? [`Twoje zgłoszenie: ${orderUrl}`] : []),
    '',
    'LESZY.RUN',
  ].join('\n')
  const html = [
    '<p>Cześć,</p>',
    `<p>drużyna <strong>${escapeHtml(team.name)}</strong> ${lead} <strong>${escapeHtml(event.name)}</strong>.</p>`,
    htmlBlock(facts),
    '<p>Skład:</p>',
    `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
    awaiting ? `<p>${escapeHtml(awaiting)}</p>` : '',
    amounts.length ? htmlBlock(amounts) : '',
    payment.length ? htmlBlock(payment) : '',
    note ? `<p>${escapeHtml(note)}</p>` : '',
    link(url, 'Zarządzaj składem'),
    orderUrl ? link(orderUrl, 'Twoje zgłoszenie') : '',
    '<p>LESZY.RUN</p>',
  ].join('')
  return { subject: `Drużyna ${team.name} jest na liście — ${event.name}`, text, html }
}

/**
 * To an adult swapped out of a squad. event { name }, team { name }. `child: true`: to the parent a
 * captain named for a child, about that child (firstName is the child's).
 */
export function squadRemovedEmail({ event, team, firstName, child = false }) {
  if (child) return childRemovedEmail({ event, team, firstName })
  const greeting = firstName ? `Cześć ${firstName},` : 'Cześć,'
  const after = 'Kapitan zmienił skład, więc Twoje zgłoszenie nie jest już aktywne.'
  const text = [
    greeting,
    '',
    `nie jesteś już w składzie drużyny ${team.name} na zawody ${event.name}. ${after}`,
    '',
    'LESZY.RUN',
  ].join('\n')
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>nie jesteś już w składzie drużyny <strong>${escapeHtml(team.name)}</strong> na zawody <strong>${escapeHtml(event.name)}</strong>. ${escapeHtml(after)}</p>`,
    '<p>LESZY.RUN</p>',
  ].join('')
  return { subject: `Nie jesteś już w składzie drużyny ${team.name}`, text, html }
}

function childRemovedEmail({ event, team, firstName }) {
  const who = firstName ? `Twoje dziecko, ${firstName},` : 'Twoje dziecko'
  const after = 'Kapitan zmienił skład, więc zgłoszenie dziecka nie jest już aktywne i nie potrzebujemy Twojej zgody.'
  const text = [
    'Dzień dobry,',
    '',
    `${who} nie jest już w składzie drużyny ${team.name} na zawody ${event.name}. ${after}`,
    '',
    'LESZY.RUN',
  ].join('\n')
  const html = [
    '<p>Dzień dobry,</p>',
    `<p>${escapeHtml(who)} nie jest już w składzie drużyny <strong>${escapeHtml(team.name)}</strong> na zawody <strong>${escapeHtml(event.name)}</strong>. ${escapeHtml(after)}</p>`,
    '<p>LESZY.RUN</p>',
  ].join('')
  return { subject: `Dziecko nie jest już w składzie drużyny ${team.name}`, text, html }
}

/**
 * To the captain, after a swap or an add. event { name }, team { name }, members as in
 * teamConfirmationEmail, link (the squad page). removedName (first name) is null on an add.
 * consentAsked is the first name of an adult whose consent e-mail goes out now, else null;
 * parentAsked the name of a child's parent (not the captain) whose consent e-mail goes out now.
 */
export function squadChangedEmail({
  event, team, members, link: url, removedName = null, addedName, consentAsked = null, parentAsked = null,
}) {
  const lines = members.map(memberLine)
  const changes = [removedName ? `Wypisano: ${removedName}` : null, `Dopisano: ${addedName}`].filter(Boolean)
  const asked = parentAsked ? `${parentAsked} dostanie e-mail z prośbą o zgodę na udział dziecka.`
    : consentAsked ? `${consentAsked} dostanie osobny e-mail z prośbą o akceptację regulaminu.` : null
  const text = [
    'Cześć,',
    '',
    `skład drużyny ${team.name} na zawody ${event.name} został zmieniony.`,
    '',
    ...changes,
    ...(asked ? ['', asked] : []),
    '',
    'Skład:',
    ...lines.map((l) => `- ${l}`),
    '',
    `Zarządzaj składem: ${url}`,
    '',
    'LESZY.RUN',
  ].join('\n')
  const html = [
    '<p>Cześć,</p>',
    `<p>skład drużyny <strong>${escapeHtml(team.name)}</strong> na zawody <strong>${escapeHtml(event.name)}</strong> został zmieniony.</p>`,
    `<p>${changes.map(escapeHtml).join('<br>')}</p>`,
    asked ? `<p>${escapeHtml(asked)}</p>` : '',
    '<p>Skład:</p>',
    `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
    link(url, 'Zarządzaj składem'),
    '<p>LESZY.RUN</p>',
  ].join('')
  return { subject: `Zmiana składu drużyny ${team.name} — ${event.name}`, text, html }
}
