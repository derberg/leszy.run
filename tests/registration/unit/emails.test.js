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
