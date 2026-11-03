// Plan 3, task 5: the payment e-mails (P-24 unit half). Pure functions, no
// runtime APIs. The confirmation is the payment confirmation, not a fiscal
// receipt, and no e-mail ever mentions a bib (numbers are assigned later).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  orderConfirmationEmail,
  paymentReminderEmail,
  orderExpiredEmail,
  paymentRefundedEmail,
  operatorAlertEmail,
  ALERT_HINTS,
} from '../../../supabase/functions/_shared/registration/emails.js'
import { formatPln } from '../../../supabase/functions/_shared/registration/money.js'

const event = { name: 'Bieg Leszego <2026>', slug: 'bieg-leszego-2026', eventDate: '2026-11-28', place: 'Nieborowice' }
const order = {
  id: '6f1c2a54-0000-4000-8000-000000000001',
  entryTotal: 6000, total: 6000,
  paidTransactionId: 'TXN-ABC-123', paidAt: '2026-10-29T10:15:00Z',
  expiresAt: '2026-11-05T10:15:00Z',
}
const lines = [{ firstName: 'Ola', lastName: 'Leśna', competition: 'Bieg 9 km', ageGroupLabel: 'K open', startTime: '10:00', amount: 6000 }]
const organizer = { name: 'Klub ZATYRANI' }

const all = () => [
  orderConfirmationEmail({ event, order, lines, organizer }),
  paymentReminderEmail({ event, order, payUrl: 'https://www.leszy.run/zamowienie/x' }),
  orderExpiredEmail({ event, order, eventUrl: 'https://www.leszy.run/events/bieg-leszego-2026' }),
  paymentRefundedEmail({ event, order, amount: order.total, reason: 'late' }),
  paymentRefundedEmail({ event, order, amount: order.total, reason: 'double' }),
  operatorAlertEmail({ alerts: [{ kind: 'late_refund', orderId: order.id, payload: { grosze: 6000 }, createdAt: '2026-10-29T10:15:00Z' }] }),
]

test('P-24 orderConfirmationEmail: subject, every person, the amount lines, the organizer, the transaction and date', () => {
  const m = orderConfirmationEmail({ event, order, lines, organizer })
  assert.equal(m.subject, 'Opłacone — Bieg Leszego <2026>')
  for (const part of [m.text, m.html]) {
    assert.match(part, /Ola Leśna/)
    assert.match(part, /Bieg 9 km/)
    assert.match(part, /K open/)
    assert.match(part, /10:00/)
    assert.ok(part.includes(`Opłaty startowe`), 'entry fees line')
    assert.ok(part.includes('w imieniu i na rzecz Organizatora: Klub ZATYRANI'))
    assert.doesNotMatch(part, /Wsparcie|Obsługa płatności/) // G-76
    assert.ok(part.includes('Razem'))
    assert.ok(part.includes(formatPln(6000)), 'amount')
    assert.ok(part.includes('TXN-ABC-123'))
    assert.ok(part.includes('29.10.2026'), 'payment date (Warsaw)')
  }
  assert.ok(m.text.includes(`Razem: ${formatPln(6000)}`))
  assert.ok(m.html.includes('Bieg Leszego &lt;2026&gt;'), 'html escaped')
  assert.ok(!m.html.includes('<2026>'))
  assert.match(m.text, /nie jest paragonem/)
})

test('P-24 orderConfirmationEmail: no transaction id, no transaction line', () => {
  const m = orderConfirmationEmail({ event, organizer, lines, order: { ...order, paidTransactionId: null } })
  assert.ok(!m.text.includes('Transakcja dpay'))
})

test('P-24 every payment e-mail has text and html, a subject, and never mentions a bib', () => {
  for (const m of all()) {
    assert.equal(typeof m.subject, 'string')
    assert.ok(m.subject.length > 0)
    assert.equal(typeof m.text, 'string')
    assert.equal(typeof m.html, 'string')
    assert.ok(m.text.length > 0 && m.html.length > 0)
    for (const part of [m.subject, m.text, m.html]) {
      assert.doesNotMatch(part, /\bbib\b|numer startowy|numer startowego/i)
    }
  }
})

test('P-24 amounts are formatted with formatPln, never a dot or a float', () => {
  const [conf, remind, , late] = all()
  assert.ok(remind.text.includes(formatPln(6000)))
  assert.ok(late.text.includes(formatPln(6000)))
  for (const m of [conf, remind, late]) assert.doesNotMatch(m.text, /\d+\.\d{2} ?zł|61\.76/)
})

test('P-24 the reminder links the pay page and says when the order expires; the expired notice offers a new registration', () => {
  const [, remind, expired] = all()
  assert.ok(remind.text.includes('https://www.leszy.run/zamowienie/x'))
  assert.match(remind.text, /05\.11\.2026/)
  assert.match(remind.subject, /Bieg Leszego/)
  assert.match(expired.subject, /^Zgłoszenie wygasło — /)
  assert.ok(expired.text.includes('Zapisz się ponownie'))
  assert.ok(expired.text.includes('https://www.leszy.run/events/bieg-leszego-2026'))
})

test('P-24 the refund e-mail names the full amount and the reason, late or double', () => {
  const late = paymentRefundedEmail({ event, order, amount: 6000, reason: 'late' })
  const double = paymentRefundedEmail({ event, order, amount: 6000, reason: 'double' })
  assert.match(late.subject, /^Płatność zwrócona — /)
  assert.notEqual(late.text, double.text)
  assert.ok(late.text.includes(formatPln(6000)))
  assert.throws(() => paymentRefundedEmail({ event, order, amount: 6000, reason: 'other' }))
})

test('P-24 the operator alert lists every alert with its kind and order', () => {
  const m = operatorAlertEmail({ alerts: [
    { kind: 'late_refund', orderId: 'o-1', payload: { grosze: 6000 }, createdAt: '2026-10-29T10:15:00Z' },
    { kind: 'amount_mismatch', orderId: null, payload: null, createdAt: '2026-10-29T10:16:00Z' },
  ] })
  assert.match(m.subject, /^\[ALERT\]/)
  for (const s of ['late_refund', 'o-1', 'amount_mismatch']) assert.ok(m.text.includes(s))
})

test('P-24 (P3-R9) a 0 zł order: „Zapis potwierdzony”, no payment wording and no amount lines', () => {
  const m = orderConfirmationEmail({
    event, organizer, lines,
    order: { ...order, entryTotal: 0, total: 0, paidTransactionId: null },
  })
  assert.equal(m.subject, 'Zapis potwierdzony — Bieg Leszego <2026>')
  for (const part of [m.text, m.html]) {
    assert.match(part, /zostało potwierdzone/)
    assert.match(part, /Ola Leśna/)
    assert.doesNotMatch(part, /Opłacone|Opłaty startowe|dpay|Razem|płatnoś|paragon/i)
  }
})

test('P-24 the confirmation puts the date and place before the full stop and links the order page', () => {
  const m = orderConfirmationEmail({ event, order, lines, organizer, orderUrl: 'https://www.leszy.run/zamowienie/abc' })
  assert.ok(m.text.includes('na zawody Bieg Leszego <2026> (28.11.2026, Nieborowice) została przyjęta.'))
  assert.ok(m.text.includes('https://www.leszy.run/zamowienie/abc'))
  assert.ok(m.html.includes('href="https://www.leszy.run/zamowienie/abc"'))
})

test('P-24 the refund e-mail says what happened for each confirm_order reason', () => {
  const texts = new Set()
  for (const reason of ['late', 'double', 'double_payment', 'closed', 'full', 'duplicate', 'cancelled', 'unavailable']) {
    const m = paymentRefundedEmail({ event, order, amount: 6000, reason })
    assert.match(m.subject, /^Płatność zwrócona — /)
    texts.add(m.text)
  }
  assert.ok(texts.size >= 7, 'a sentence per reason (double and double_payment share one)')
  assert.match(paymentRefundedEmail({ event, order, amount: 6000, reason: 'cancelled' }).text, /anulowaniu/)
})

test('V-26 D7-20 a late payment that cannot re-claim its code or its extra gets its own sentence', () => {
  assert.match(paymentRefundedEmail({ event, order, amount: 9600, reason: 'voucher' }).text, /kod rabatowy został w tym czasie wykorzystany/)
  assert.match(paymentRefundedEmail({ event, order, amount: 9600, reason: 'stock' }).text, /dodatek został w tym czasie wyprzedany/)
  assert.throws(() => paymentRefundedEmail({ event, order, amount: 9600, reason: 'nope' }), /unknown refund reason/)
})

// P3-R15 re-review I2: an unpaid entry holds no place, so neither the reminder nor the expiry
// notice may say a place is kept or released (CLAUDE.md: copy never says an unpaid entry holds a place).
test('P-58 the reminder and the expiry notice never say an unpaid entry holds or releases a place', () => {
  const reminder = paymentReminderEmail({ event, order, payUrl: 'https://www.leszy.run/zamowienie/x' })
  const expired = orderExpiredEmail({ event, order, eventUrl: 'https://www.leszy.run/events/bieg-leszego-2026' })
  for (const m of [reminder, expired]) {
    for (const part of [m.text, m.html]) {
      assert.doesNotMatch(part, /zwolni/i)
      assert.doesNotMatch(part, /zarezerw/i)
    }
  }
  for (const part of [reminder.text, reminder.html]) {
    assert.ok(part.includes('Miejsce zajmuje dopiero opłacone zgłoszenie'), 'a place is taken only by a paid entry')
    assert.ok(part.includes('nie będzie można go już opłacić'))
    assert.ok(part.includes('zgłoszenie wygaśnie'))
  }
  assert.ok(reminder.text.includes('Bez wpłaty do 05.11.2026, 11:15 zgłoszenie wygaśnie.'), reminder.text)
  for (const part of [expired.text, expired.html]) assert.match(part, /wygasło, bo nie zostało opłacone w terminie/)
  for (const part of [expired.text, expired.html]) assert.ok(part.includes('Jeśli są jeszcze wolne miejsca, możesz zapisać się ponownie'), part)
})

// ---------------------------------------------------------------- Plan 4: groups (G-28)

import { consentRequestEmail, freeConfirmationEmail } from '../../../supabase/functions/_shared/registration/emails.js'

const consentArgs = {
  event: { name: 'Bieg Leszego <2026>', eventDate: '2026-11-28', place: 'Nieborowice' },
  person: { firstName: 'Piotr' },
  registeredBy: 'Ola Leśna',
  competition: { name: 'Bieg 9 km', startTime: '10:00' },
  link: 'https://www.leszy.run/zgoda#TOKEN_abc-123',
  dataInfoUrl: 'https://www.leszy.run/events/bieg-leszego-2026/informacja-o-danych',
}

test('G-28 consentRequestEmail: subject, who registered, the competition and start, the link, the office line, the data information', () => {
  const m = consentRequestEmail(consentArgs)
  assert.equal(m.subject, 'Zapisano Cię na Bieg Leszego <2026> — zaakceptuj regulamin')
  for (const part of [m.text, m.html]) {
    assert.ok(part.includes('Piotr'))
    assert.ok(part.includes('Ola Leśna'), 'names who provided the data (Art. 14)')
    assert.ok(part.includes('Bieg 9 km'))
    assert.ok(part.includes('28.11.2026'))
    assert.ok(part.includes('10:00'))
    assert.ok(part.includes('Zaakceptuj regulamin'))
    assert.ok(part.includes('Jeśli nie zaakceptujesz online, podpiszesz regulamin w biurze zawodów.'))
    assert.ok(part.includes(consentArgs.dataInfoUrl))
    assert.doesNotMatch(part, /\bbib\b|numer startowy|\bnr\b/i)
  }
  assert.ok(m.text.includes('https://www.leszy.run/zgoda#TOKEN_abc-123'))
  assert.ok(m.html.includes('href="https://www.leszy.run/zgoda#TOKEN_abc-123"'))
  assert.ok(m.html.includes('Bieg Leszego &lt;2026&gt;'), 'html escaped')
  assert.ok(!m.html.includes('<2026>'))
})

test('TM-10 consentRequestEmail for a member who owes details: the data note says the captain gave part of it, the link asks for the rest', () => {
  const m = consentRequestEmail({ ...consentArgs, detailsOwed: true, team: { name: 'Leśne Dziki' } })
  for (const part of [m.text, m.html]) {
    assert.ok(part.includes('Twoje imię, nazwisko, datę urodzenia, płeć, e-mail i ewentualnie inne pola zgłoszenia podał(a) Ola Leśna.'), part)
    assert.ok(part.includes('Brakujące dane, np. telefon, uzupełnisz sam(a) pod linkiem.'))
    assert.ok(part.includes('Uzupełnij dane i zaakceptuj regulamin'))
    assert.ok(!part.includes('telefon i pozostałe pola zgłoszenia) podał(a)'))
  }
  assert.equal(m.subject, 'Zapisano Cię na Bieg Leszego <2026> — uzupełnij dane i zaakceptuj regulamin')
  // Without it the e-mail is the one an added adult always got.
  assert.ok(consentRequestEmail(consentArgs).text.includes('telefon i pozostałe pola zgłoszenia) podał(a) Ola Leśna'))
})

test('G-28 consentRequestEmail as a reminder: the subject starts with „Przypomnienie: ”', () => {
  const m = consentRequestEmail({ ...consentArgs, reminder: true })
  assert.equal(m.subject, 'Przypomnienie: Zapisano Cię na Bieg Leszego <2026> — zaakceptuj regulamin')
})

const freeEvent = {
  name: 'Bieg Leszego <2026>', eventDate: '2026-11-28', place: 'Nieborowice, Polana', officePlace: 'Nieborowice, Polana',
  url: 'https://www.leszy.run/events/bieg-leszego-2026',
}
const hours = [{ starts_at: '2026-11-28T07:00:00Z', ends_at: '2026-11-28T09:00:00Z' }]
const self = { role: 'self', firstName: 'Ola', lastName: 'Leśna', competition: 'Bieg 9 km', ageGroupLabel: 'K open', startTime: '10:00' }

test('G-33 freeConfirmationEmail for one runner registering themself: Plan 2\'s „Jesteś na liście”', () => {
  const m = freeConfirmationEmail({ event: freeEvent, people: [self], payerFirstName: 'Ola', officeHours: hours })
  assert.equal(m.subject, 'Jesteś na liście — Bieg Leszego <2026>')
  assert.ok(m.text.startsWith('Cześć Ola,\n\njesteś na liście startowej zawodów Bieg Leszego <2026>.'))
  for (const s of ['Konkurencja: Bieg 9 km', 'Kategoria: K open', 'Start: 28.11.2026, godz. 10:00', 'Miejsce: Nieborowice, Polana',
    'Biuro zawodów (Nieborowice, Polana):', '- 28.11.2026 08:00–10:00', `Strona zawodów: ${freeEvent.url}`]) {
    assert.ok(m.text.includes(s), s)
  }
  assert.doesNotMatch(m.text, /numer startowy|\bnr\b/i)
})

test('G-28 freeConfirmationEmail for a family: „Jesteście na liście”, every person with their competition, the adult awaiting consent', () => {
  const people = [
    self,
    { role: 'adult', firstName: 'Piotr', lastName: 'Leśny', competition: 'Bieg 9 km', ageGroupLabel: 'M open', startTime: '10:00' },
    { role: 'minor', firstName: 'Zosia', lastName: 'Leśna', competition: 'Bieg dzieci 1 km', ageGroupLabel: null, startTime: '09:00' },
  ]
  const m = freeConfirmationEmail({ event: freeEvent, people, payerFirstName: 'Ola', officeHours: hours })
  assert.equal(m.subject, 'Jesteście na liście — Bieg Leszego <2026>')
  for (const part of [m.text, m.html]) {
    for (const s of ['Ola Leśna', 'Piotr Leśny', 'Zosia Leśna', 'Bieg 9 km', 'Bieg dzieci 1 km', 'M open', '09:00', '28.11.2026']) {
      assert.ok(part.includes(s), s)
    }
    assert.match(part, /Piotr Leśny[^\n<]*regulamin/, 'the added adult is told to accept the regulamin')
    assert.doesNotMatch(part, /\bbib\b|numer startowy/i)
  }
  assert.ok(m.html.includes('Bieg Leszego &lt;2026&gt;'))
})

test('G-28 freeConfirmationEmail for one other person (the payer does not run): named in the subject, sent to the payer', () => {
  const m = freeConfirmationEmail({
    event: freeEvent, payerFirstName: 'Ola', officeHours: [],
    people: [{ role: 'minor', firstName: 'Zosia', lastName: 'Leśna', competition: 'Bieg dzieci 1 km', ageGroupLabel: null, startTime: '09:00' }],
  })
  assert.equal(m.subject, 'Zosia Leśna jest na liście — Bieg Leszego <2026>')
  assert.ok(m.text.startsWith('Cześć Ola,'))
  assert.ok(m.text.includes('Zosia Leśna'))
})

test('G-35 consentRequestEmail with nobody named: „Inna osoba” starts a sentence, „inna osoba” sits inside one', () => {
  const m = consentRequestEmail({ ...consentArgs, registeredBy: null })
  assert.ok(m.text.includes('Inna osoba zapisał(a) Cię na zawody'))
  assert.ok(m.text.includes('podał(a) inna osoba.'), m.text)
  assert.ok(!m.text.includes('podał(a) Inna osoba'))
  assert.ok(m.html.includes('podał(a) inna osoba.'))
})

test('G-35 the consent link is absolute without PUBLIC_SITE_URL: it falls back to https://www.leszy.run (m-3)', async () => {
  const { publicSite } = await import('../../../supabase/functions/_shared/registration/consentRequests.js')
  const prev = globalThis.Deno
  try {
    globalThis.Deno = { env: { get: () => undefined } }
    assert.equal(publicSite(), 'https://www.leszy.run')
    globalThis.Deno = { env: { get: (k) => (k === 'PUBLIC_SITE_URL' ? '  ' : undefined) } }
    assert.equal(publicSite(), 'https://www.leszy.run')
    globalThis.Deno = { env: { get: (k) => (k === 'PUBLIC_SITE_URL' ? 'http://localhost:5173/' : undefined) } }
    assert.equal(publicSite(), 'http://localhost:5173')
    assert.equal(publicSite(''), 'https://www.leszy.run', 'an empty override falls back too')
  } finally {
    if (prev === undefined) delete globalThis.Deno
    else globalThis.Deno = prev
  }
})

// ---------------------------------------------------------------- teams (Plan 5)

import { squadChangedEmail, squadRemovedEmail, teamConfirmationEmail } from '../../../supabase/functions/_shared/registration/emails.js'

const teamArgs = {
  event,
  team: { name: 'Wilcze <Stado>', competition: 'Sztafeta' },
  members: [
    { firstName: 'Ola', lastName: 'Leśna', role: 'self', ageGroupLabel: 'K open' },
    { firstName: 'Piotr', lastName: 'Borowy', role: 'adult', ageGroupLabel: 'M open' },
    { firstName: 'Zosia', lastName: 'Leśna', role: 'minor', ageGroupLabel: null },
    { firstName: 'Staś', lastName: 'Leśna', role: 'minor', ageGroupLabel: null },
  ],
  link: 'https://www.leszy.run/events/bieg-leszego-2026/druzyna/t1',
  paid: null,
}

test('T-40 teamConfirmationEmail, free: subject, every member, „opiekun: kapitan” for minors only, the squad link, no payment wording, no bib, no leg', () => {
  const m = teamConfirmationEmail(teamArgs)
  assert.equal(m.subject, 'Drużyna Wilcze <Stado> jest na liście — Bieg Leszego <2026>')
  for (const part of [m.text, m.html]) {
    for (const name of ['Ola Leśna', 'Piotr Borowy', 'Zosia Leśna', 'Staś Leśna']) assert.ok(part.includes(name), name)
    assert.ok(part.includes('Zarządzaj składem'))
    assert.ok(part.includes(teamArgs.link))
    assert.ok(part.includes('Sztafeta'))
    assert.doesNotMatch(part, /Razem|paragonem|Transakcja|Opłaty startowe/)
    assert.doesNotMatch(part, /numer startow|\bbib\b|zmiana \d|\d\. zmiana/i)
  }
  assert.equal(m.text.match(/opiekun: kapitan/g).length, 2)
  assert.match(m.text, /Staś Leśna.*opiekun: kapitan/)
  assert.ok(m.html.includes('Wilcze &lt;Stado&gt;'))
  assert.ok(!m.html.includes('<Stado>'))
})

test('T-41 teamConfirmationEmail, paid: the amounts, the organizer, the transaction, the order page', () => {
  const m = teamConfirmationEmail({
    ...teamArgs,
    paid: { order: { ...order, entryTotal: 24000, total: 24000 }, organizer, orderUrl: 'https://www.leszy.run/zamowienie/o1' },
  })
  assert.equal(m.subject, 'Drużyna Wilcze <Stado> jest na liście — Bieg Leszego <2026>')
  for (const part of [m.text, m.html]) {
    assert.ok(part.includes('w imieniu i na rzecz Organizatora: Klub ZATYRANI'))
    assert.ok(part.includes('Razem'))
    assert.ok(part.includes(formatPln(24000)))
    assert.ok(part.includes('TXN-ABC-123'))
    assert.ok(part.includes('29.10.2026'))
    assert.ok(part.includes('https://www.leszy.run/zamowienie/o1'))
    assert.ok(part.includes('Zarządzaj składem'))
  }
  assert.match(m.text, /nie jest paragonem/)
})

test('T-42 squadRemovedEmail: subject, the event, no address, no bib', () => {
  const m = squadRemovedEmail({ event, team: { name: 'Wilcze <Stado>' }, firstName: 'Piotr' })
  assert.equal(m.subject, 'Nie jesteś już w składzie drużyny Wilcze <Stado>')
  assert.ok(m.text.startsWith('Cześć Piotr,'))
  for (const part of [m.text, m.html]) assert.ok(part.includes('LESZY.RUN'))
  assert.ok(m.text.includes('Bieg Leszego <2026>'))
  assert.ok(m.html.includes('Wilcze &lt;Stado&gt;'))
  assert.ok(!m.html.includes('<Stado>'))
})

test('T-42 squadChangedEmail: who left, who came, the squad and the link; a request promised only when one goes out; no address, no bib, no leg', () => {
  const { paid: _paid, ...args } = teamArgs
  const m = squadChangedEmail({ ...args, removedName: 'Piotr', addedName: 'Anna <Nowa>', consentAsked: 'Anna' })
  assert.equal(m.subject, 'Zmiana składu drużyny Wilcze <Stado> — Bieg Leszego <2026>')
  for (const part of ['Wypisano: Piotr', 'Dopisano: Anna <Nowa>', 'Staś Leśna — opiekun: kapitan', 'Anna dostanie osobny e-mail', `Zarządzaj składem: ${args.link}`, 'LESZY.RUN']) {
    assert.ok(m.text.includes(part), part)
  }
  assert.ok(m.html.includes('Anna &lt;Nowa&gt;'))
  assert.ok(!m.html.includes('<Nowa>'))
  assert.doesNotMatch(m.text, /numer startowy|@|zmiana \d/i)

  const added = squadChangedEmail({ ...args, addedName: 'Lena Nowa' })
  assert.doesNotMatch(added.text, /Wypisano|osobny e-mail/)
  assert.ok(added.text.includes('Dopisano: Lena Nowa'))
})

test('T-40 consentRequestEmail with a team: „w drużynie <nazwa>”; without one the sentence is unchanged', () => {
  const m = consentRequestEmail({ ...consentArgs, team: { name: 'Wilcze <Stado>' } })
  assert.ok(m.text.includes(`zapisał(a) Cię na zawody ${event.name} w drużynie Wilcze <Stado>.`))
  assert.ok(m.html.includes('w drużynie Wilcze &lt;Stado&gt;'))
  assert.ok(!m.html.includes('<Stado>'))
  assert.doesNotMatch(consentRequestEmail(consentArgs).text, /drużyn/)
})

test('Plan 6 Task 5 the operator digest says what to do for the organizer refund alerts, once per kind, and nothing for others', () => {
  const kinds = ['refund_unknown', 'refund_stalled', 'refund_never_sent', 'refund_email_failed', 'refund_email_unknown', 'refund_followup_failed']
  const m = operatorAlertEmail({ alerts: [
    ...kinds.map((kind) => ({ kind, orderId: 'o-1', payload: { refundId: 'r-1', reason: 'organizer' }, createdAt: '2026-11-01T10:00:00Z' })),
    { kind: 'refund_unknown', orderId: 'o-2', payload: null, createdAt: '2026-11-01T10:01:00Z' },
    { kind: 'late_refund', orderId: 'o-3', payload: null, createdAt: '2026-11-01T10:02:00Z' },
  ] })
  assert.match(m.text, /Co zrobić:/)
  for (const k of kinds) {
    assert.ok(ALERT_HINTS[k], k)
    assert.equal(m.text.split('\n').filter((l) => l.startsWith(`- ${k}: `)).length, 1, k)
  }
  assert.ok(!m.text.includes('- late_refund: '))
  assert.equal(m.text.split('resolve-registration-refund.js').length - 1, 3, 'unknown, stalled and never_sent name the script')
  assert.ok(m.html.includes('Co zrobić:'))
  const plain = operatorAlertEmail({ alerts: [{ kind: 'late_refund', orderId: 'o', payload: null, createdAt: '2026-11-01T10:00:00Z' }] })
  assert.doesNotMatch(plain.text, /Co zrobić/)
})

test('O-48 the operator digest tells the operator to record a refund made in the dpay panel with record-external-refund.js', () => {
  const m = operatorAlertEmail({ alerts: [{
    kind: 'refund_external', orderId: 'o-x', payload: { txn: 'T-1', dpayRefunded: 2000, recorded: 0, inFlight: 0, difference: 2000 },
    createdAt: '2026-11-02T10:00:00Z',
  }] })
  const line = m.text.split('\n').find((l) => l.startsWith('- refund_external: '))
  assert.ok(line, m.text)
  assert.match(line, /backend\/scripts\/record-external-refund\.js --order <orderId> --amount/)
  assert.match(line, /panelu dpay/)
  assert.ok(m.text.includes('"difference":2000'))
  assert.ok(m.html.includes('record-external-refund.js'))
})

test('O-44 M1/M6 the resolve-script hints for refund_unknown, refund_pending and refund_insufficient_balance appear only for an organizer refund', () => {
  const at = '2026-11-01T10:00:00Z'
  const auto = operatorAlertEmail({ alerts: ['refund_unknown', 'refund_pending', 'refund_insufficient_balance'].map((kind) => (
    { kind, orderId: 'o-a', payload: { refundId: 'r-a', reason: 'late' }, createdAt: at })) })
  assert.doesNotMatch(auto.text, /Co zrobić/, 'an automatic refund keeps Plan 3\'s manual handling')
  assert.ok(!auto.text.includes('resolve-registration-refund.js'))

  const mixed = operatorAlertEmail({ alerts: [
    { kind: 'refund_unknown', orderId: 'o-a', payload: { reason: 'late' }, createdAt: at },
    { kind: 'refund_unknown', orderId: 'o-o', payload: { reason: 'organizer' }, createdAt: at },
    { kind: 'refund_pending', orderId: 'o-p', payload: { reason: 'organizer' }, createdAt: at },
    { kind: 'refund_insufficient_balance', orderId: 'o-i', payload: { reason: 'organizer' }, createdAt: at },
  ] })
  for (const k of ['refund_unknown', 'refund_pending', 'refund_insufficient_balance']) {
    assert.equal(mixed.text.split('\n').filter((l) => l.startsWith(`- ${k}: `)).length, 1, k)
  }
  assert.equal(mixed.text.split('resolve-registration-refund.js').length - 1, 2, 'unknown and pending name the script')
  assert.match(mixed.text, /- refund_insufficient_balance: .*rezerwacja zwolniona/)
})
