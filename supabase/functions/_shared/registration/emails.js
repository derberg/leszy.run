// The paid registration e-mails. Pure: every input is passed in, nothing is read from the
// runtime, so the same module runs in the edge functions and in node:test. Amounts are
// integer grosze, shown only through formatPln. No e-mail mentions a bib: numbers are
// assigned later, by the organizer. The confirmation is the payment confirmation, not a
// fiscal receipt: the entry fees are collected on the organizer's behalf.
import { formatPln } from './money.js'

const TZ = 'Europe/Warsaw'
const dayFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** '2026-11-28' → '28.11.2026' (a calendar date, no time zone involved). */
function isoDay(iso) {
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

const textBlock = (pairs) => pairs.map(([k, v]) => `${k}: ${v}`)
const htmlBlock = (pairs) => `<p>${pairs.map(([k, v]) => `${escapeHtml(k)}: <strong>${escapeHtml(v)}</strong>`).join('<br>')}</p>`
const link = (url, label) => `<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`

function personLines(lines) {
  return lines.map((l) => {
    const name = `${l.firstName ?? ''} ${l.lastName ?? ''}`.trim()
    const facts = [l.competition, l.ageGroupLabel ? `kategoria ${l.ageGroupLabel}` : null, l.startTime ? `start ${l.startTime}` : null]
      .filter(Boolean).join(', ')
    return `${name} — ${facts}`
  })
}

/**
 * The payment confirmation. event { name, slug?, eventDate?, place? }, order { id, entryTotal,
 * total, paidTransactionId, paidAt }, lines [{ firstName, lastName,
 * competition, ageGroupLabel, startTime }], organizer { name }, orderUrl (optional: the order page).
 * A 0 zł order paid nothing, so it is a registration confirmation (P3-R9): „Zapis potwierdzony”,
 * no payment wording and no amount lines.
 */
export function orderConfirmationEmail({ event, order, lines, organizer, orderUrl = null }) {
  const people = personLines(lines)
  const when = [isoDay(event.eventDate), event.place].filter(Boolean).join(', ')
  const whenText = when ? ` (${when})` : ''
  const free = order.total === 0
  const amounts = free ? [] : [
    [`Opłaty startowe (pobrane w imieniu i na rzecz Organizatora: ${organizer.name})`, formatPln(order.entryTotal)],
    ['Razem', formatPln(order.total)],
  ]
  const payment = free ? [] : [
    ...(order.paidTransactionId ? [['Transakcja dpay', order.paidTransactionId]] : []),
    ...(warsawDateTime(order.paidAt) ? [['Data płatności', warsawDateTime(order.paidAt)]] : []),
  ]
  const note = free ? null : 'To potwierdzenie płatności, nie jest paragonem ani fakturą.'
  const lead = (name) => free
    ? `Twoje zgłoszenie na zawody ${name}${whenText} zostało potwierdzone.`
    : `płatność za zgłoszenie na zawody ${name}${whenText} została przyjęta.`
  const leadHtml = free
    ? `Twoje zgłoszenie na zawody <strong>${escapeHtml(event.name)}</strong>${escapeHtml(whenText)} zostało potwierdzone.`
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

  return { subject: `${free ? 'Zapis potwierdzony' : 'Opłacone'} — ${event.name}`, text, html }
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

/** The payment window passed without a payment. The order never held a place (P3-R15), so nothing is said about one. */
export function orderExpiredEmail({ event, order, eventUrl }) {
  const text = [
    'Cześć,',
    '',
    `Twoje zgłoszenie na zawody ${event.name} wygasło, bo nie zostało opłacone w terminie (${formatPln(order.total)}).`,
    '',
    `Zapisz się ponownie: ${eventUrl}`,
    '',
    'LESZY.RUN',
  ].join('\n')
  const html = [
    '<p>Cześć,</p>',
    `<p>Twoje zgłoszenie na zawody <strong>${escapeHtml(event.name)}</strong> wygasło, bo nie zostało opłacone w terminie (${escapeHtml(formatPln(order.total))}).</p>`,
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

/** Operator digest of operator_alerts rows: [{ kind, orderId, payload, createdAt }]. */
export function operatorAlertEmail({ alerts }) {
  const kinds = [...new Set(alerts.map((a) => a.kind))]
  const entries = alerts.map((a) => [
    `${warsawDateTime(a.createdAt) ?? a.createdAt ?? ''} ${a.kind}`.trim(),
    `zamówienie ${a.orderId ?? '—'}`,
    a.payload ? JSON.stringify(a.payload) : '',
  ].filter(Boolean).join(' · '))
  const text = [
    `Płatności wymagają sprawdzenia (${alerts.length}):`,
    '',
    ...entries.map((e) => `- ${e}`),
    '',
    'Sprawdź panel dpay przed jakimkolwiek ręcznym zwrotem.',
  ].join('\n')
  const html = [
    `<p>Płatności wymagają sprawdzenia (${alerts.length}):</p>`,
    `<ul>${entries.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`,
    '<p>Sprawdź panel dpay przed jakimkolwiek ręcznym zwrotem.</p>',
  ].join('')
  return { subject: `[ALERT] Płatności: ${kinds.join(', ')}`, text, html }
}

// ---------------------------------------------------------------- free sign-up and consent requests (Plan 4)

const fullName = (p) => `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim()

function officeLines(officeHours = []) {
  return officeHours.map((h) => `${dayFmt.format(new Date(h.starts_at))} ${timeFmt.format(new Date(h.starts_at))}–${timeFmt.format(new Date(h.ends_at))}`)
}

/**
 * The free registration confirmation, one e-mail to whoever registered (Plan 2's „Jesteś na
 * liście”, moved here from register-free). event { name, eventDate, place, officePlace, url },
 * people [{ role: self|adult|minor, firstName, lastName, competition, ageGroupLabel, startTime }],
 * payerFirstName, officeHours [{ starts_at, ends_at }].
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
 * the subject with „Przypomnienie: ”. The link is the only place the token appears.
 */
export function consentRequestEmail({ event, person, registeredBy, competition, link: url, dataInfoUrl, reminder = false }) {
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
  const dataNote = `Twoje dane (imię, nazwisko, datę urodzenia, płeć, e-mail, telefon i pozostałe pola zgłoszenia) podał(a) ${whoInside}. Kto je przetwarza, w jakim celu i jakie masz prawa:`
  const greeting = person?.firstName ? `Cześć ${person.firstName},` : 'Cześć,'
  const text = [
    greeting,
    '',
    `${who} zapisał(a) Cię na zawody ${event.name}.`,
    '',
    ...textBlock(facts),
    '',
    `Zaakceptuj regulamin: ${url}`,
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
    `<p>${escapeHtml(who)} zapisał(a) Cię na zawody <strong>${escapeHtml(event.name)}</strong>.</p>`,
    htmlBlock(facts),
    link(url, 'Zaakceptuj regulamin'),
    `<p>${escapeHtml(office)}</p>`,
    `<p>${escapeHtml(dataNote)} <a href="${escapeHtml(dataInfoUrl)}">${escapeHtml(dataInfoUrl)}</a></p>`,
    '<p>LESZY.RUN</p>',
  ].join('')
  const subject = `Zapisano Cię na ${event.name} — zaakceptuj regulamin`
  return { subject: reminder ? `Przypomnienie: ${subject}` : subject, text, html }
}
