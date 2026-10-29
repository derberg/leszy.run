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
  entryTotal: 6000, supportFee: 120, paymentFee: 56, total: 6176,
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
  operatorAlertEmail({ alerts: [{ kind: 'late_refund', orderId: order.id, payload: { grosze: 6176 }, createdAt: '2026-10-29T10:15:00Z' }] }),
]

test('P-24 orderConfirmationEmail: subject, every person, the four amount lines, the organizer, the transaction and date', () => {
  const m = orderConfirmationEmail({ event, order, lines, organizer })
  assert.equal(m.subject, 'Opłacone — Bieg Leszego <2026>')
  for (const part of [m.text, m.html]) {
    assert.match(part, /Ola Leśna/)
    assert.match(part, /Bieg 9 km/)
    assert.match(part, /K open/)
    assert.match(part, /10:00/)
    assert.ok(part.includes(`Opłaty startowe`), 'entry fees line')
    assert.ok(part.includes('w imieniu i na rzecz Organizatora: Klub ZATYRANI'))
    assert.ok(part.includes('Wsparcie LESZY.RUN'))
    assert.ok(part.includes('Obsługa płatności dpay'))
    assert.ok(part.includes('Razem'))
    for (const g of [6000, 120, 56, 6176]) assert.ok(part.includes(formatPln(g)), `amount ${g}`)
    assert.ok(part.includes('TXN-ABC-123'))
    assert.ok(part.includes('29.10.2026'), 'payment date (Warsaw)')
  }
  assert.ok(m.text.includes(`Razem: ${formatPln(6176)}`))
  assert.ok(m.html.includes('Bieg Leszego &lt;2026&gt;'), 'html escaped')
  assert.ok(!m.html.includes('<2026>'))
  assert.match(m.text, /nie jest paragonem/)
})

test('P-24 orderConfirmationEmail: support declined still lists the support line at 0,00 zł; no transaction id, no transaction line', () => {
  const m = orderConfirmationEmail({
    event, organizer, lines,
    order: { ...order, supportFee: 0, paymentFee: 55, total: 6055, paidTransactionId: null },
  })
  assert.ok(m.text.includes(`Wsparcie LESZY.RUN: ${formatPln(0)}`))
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
  assert.ok(remind.text.includes(formatPln(6176)))
  assert.ok(late.text.includes(formatPln(6176)))
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
  const late = paymentRefundedEmail({ event, order, amount: 6176, reason: 'late' })
  const double = paymentRefundedEmail({ event, order, amount: 6176, reason: 'double' })
  assert.match(late.subject, /^Płatność zwrócona — /)
  assert.notEqual(late.text, double.text)
  assert.ok(late.text.includes(formatPln(6176)))
  assert.throws(() => paymentRefundedEmail({ event, order, amount: 6176, reason: 'other' }))
})

test('P-24 the operator alert lists every alert with its kind and order', () => {
  const m = operatorAlertEmail({ alerts: [
    { kind: 'late_refund', orderId: 'o-1', payload: { grosze: 6176 }, createdAt: '2026-10-29T10:15:00Z' },
    { kind: 'amount_mismatch', orderId: null, payload: null, createdAt: '2026-10-29T10:16:00Z' },
  ] })
  assert.match(m.subject, /^\[ALERT\]/)
  for (const s of ['late_refund', 'o-1', 'amount_mismatch']) assert.ok(m.text.includes(s))
})

test('P-24 (P3-R9) a 0 zł order: „Zapis potwierdzony”, no payment wording and no amount lines', () => {
  const m = orderConfirmationEmail({
    event, organizer, lines,
    order: { ...order, entryTotal: 0, supportFee: 0, paymentFee: 0, total: 0, paidTransactionId: null },
  })
  assert.equal(m.subject, 'Zapis potwierdzony — Bieg Leszego <2026>')
  for (const part of [m.text, m.html]) {
    assert.match(part, /zostało potwierdzone/)
    assert.match(part, /Ola Leśna/)
    assert.doesNotMatch(part, /Opłacone|Opłaty startowe|Wsparcie|dpay|Razem|płatnoś|paragon/i)
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
    const m = paymentRefundedEmail({ event, order, amount: 6176, reason })
    assert.match(m.subject, /^Płatność zwrócona — /)
    texts.add(m.text)
  }
  assert.ok(texts.size >= 7, 'a sentence per reason (double and double_payment share one)')
  assert.match(paymentRefundedEmail({ event, order, amount: 6176, reason: 'cancelled' }).text, /anulowaniu/)
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
