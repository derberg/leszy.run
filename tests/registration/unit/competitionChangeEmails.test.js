// Competition change, task 6: the four e-mails (pure). They name the event and the two competitions
// and nothing else: no person, no address.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  competitionChangedEmail, surchargeEmail, surchargeExpiredEmail, surchargeRefundedEmail,
} from '../../../supabase/functions/_shared/registration/emails.js'

const base = { eventName: 'Bieg Leszego <2026>', from: 'Bieg 5 km', to: 'Bieg 21 km' }
const all = (m) => `${m.subject}\n${m.text}\n${m.html ?? ''}`

test('surchargeEmail: subject, amount, link, term, escaped name', () => {
  const m = surchargeEmail({ ...base, grosze: 2000, url: 'https://x.test/zamowienie/abc', expiresAt: '2026-11-30T10:00:00Z' })
  assert.equal(m.subject, 'Dopłata za zmianę konkurencji — Bieg Leszego <2026>')
  assert.match(m.text, /Do zapłaty: 20,00 zł/)
  assert.match(m.text, /Termin: 30\.11\.2026/)
  assert.match(m.text, /z Bieg 5 km na Bieg 21 km/)
  assert.match(m.text, /https:\/\/x\.test\/zamowienie\/abc/)
  assert.match(m.html, /href="https:\/\/x\.test\/zamowienie\/abc"/)
  assert.ok(!m.html.includes('<2026>'))
})

test('surchargeEmail: the reminder variant', () => {
  const m = surchargeEmail({ ...base, grosze: 2000, url: 'https://x.test/z', reminder: true })
  assert.equal(m.subject, 'Przypomnienie: dopłata za zmianę konkurencji — Bieg Leszego <2026>')
  assert.ok(!/Termin:/.test(m.text))
})

test('competitionChangedEmail: refund line only with a refund', () => {
  const plain = competitionChangedEmail(base)
  assert.equal(plain.subject, 'Zmieniono konkurencję — Bieg Leszego <2026>')
  assert.ok(!/Zwrot/.test(plain.text))
  const refunded = competitionChangedEmail({ ...base, refundGrosze: 1500 })
  assert.match(refunded.text, /Zwrot różnicy: 15,00 zł trafi na konto, z którego zapłacono\./)
  assert.ok(!/Zwrot/.test(competitionChangedEmail({ ...base, refundGrosze: 0 }).text))
})

test('surchargeExpiredEmail: stays in the old competition', () => {
  const m = surchargeExpiredEmail(base)
  assert.equal(m.subject, 'Dopłata wygasła — zostajesz w Bieg 5 km')
  assert.match(m.text, /zostaje w konkurencji Bieg 5 km/)
})

test('surchargeRefundedEmail: one sentence per reason', () => {
  const mail = (reason) => surchargeRefundedEmail({ ...base, grosze: 2000, reason })
  assert.equal(mail('full').subject, 'Dopłata zwrócona')
  assert.match(mail('full').text, /brak wolnych miejsc w Bieg 21 km/)
  assert.match(mail('unavailable').text, /Bieg 21 km nie jest już dostępna/)
  assert.match(mail('closed').text, /zapisy zostały już zamknięte/)
  for (const r of ['entry_changed', 'cancelled', 'whatever']) {
    assert.match(mail(r).text, /zgłoszenie zmieniło się/)
    assert.ok(!/zostaje w konkurencji/.test(mail(r).text), 'a changed entry is not said to stay')
  }
  assert.match(mail('full').text, /20,00 zł/)
})

test('no mail carries an address or the word for a bib', () => {
  const mails = [
    surchargeEmail({ ...base, grosze: 100, url: 'https://x.test/z' }), competitionChangedEmail({ ...base, refundGrosze: 100 }),
    surchargeExpiredEmail(base), surchargeRefundedEmail({ ...base, grosze: 100, reason: 'full' }),
  ]
  for (const m of mails) assert.ok(!/@/.test(all(m)), m.subject)
})

// ---- Task 13: the club is told about a runner's own change or edit --------------------------

test('runnerChangeClubEmail: a competition change with its money outcome and the panel link', async () => {
  const { runnerChangeClubEmail } = await import('../../../supabase/functions/_shared/registration/emails.js')
  const url = 'https://www.leszy.run/klub/k/wydarzenia/e/zgloszenia'
  const m = runnerChangeClubEmail({
    eventName: 'Bieg Leszego', person: 'Ola Leśna', url,
    change: { from: 'Bieg 9 km', to: 'Bieg 5 km', outcome: 'refund', grosze: -2000, refundStatus: 'accepted' },
  })
  assert.equal(m.subject, 'Zawodnik zmienił zgłoszenie — Bieg Leszego')
  for (const part of ['Ola Leśna', 'Bieg 9 km', 'Bieg 5 km', '20,00 zł', url]) assert.ok(m.text.includes(part), part)
  assert.ok(m.html.includes('Ola Leśna'))
  const s = runnerChangeClubEmail({
    eventName: 'B', person: '<b>X</b>', url,
    change: { from: 'A', to: 'C', outcome: 'surcharge', grosze: 2000 },
  })
  assert.match(s.text, /dopłat/i)
  assert.ok(!s.html.includes('<b>X</b>'), 'escaped')
  const rejected = runnerChangeClubEmail({
    eventName: 'B', person: 'X', url, change: { from: 'A', to: 'C', outcome: 'refund', grosze: -500, refundStatus: 'rejected' },
  })
  assert.match(rejected.text, /Zwróć wpłatę/)
})

test('runnerChangeClubEmail: a data edit names the fields, never their values', async () => {
  const { runnerChangeClubEmail } = await import('../../../supabase/functions/_shared/registration/emails.js')
  const m = runnerChangeClubEmail({ eventName: 'B', person: 'Ola Leśna', url: 'https://x/y', fields: ['birthDate', 'city', 'icePhone'] })
  for (const part of ['Data urodzenia', 'Miejscowość', 'Telefon kontaktu alarmowego']) assert.ok(m.text.includes(part), part)
})
