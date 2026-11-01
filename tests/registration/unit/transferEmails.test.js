// Plan 7, task 7: the transfer e-mails (§7) and the transferred line of an order e-mail (carry T7 b).
// Pure builders, no stack. Scenarios V-52, V-53 and V-58 in docs/registration/scenario-matrix.md.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MONEY_NOTE, transferAcceptedEmail, transferByOrganizerEmail, transferCancelledEmail, transferConfirmationEmail, transferInviteEmail,
} from '../../../supabase/functions/_shared/registration/transferEmails.js'
import {
  consentRequestEmail, orderConfirmationEmail, paymentReminderEmail, teamConfirmationEmail,
} from '../../../supabase/functions/_shared/registration/emails.js'
import { buildSendGridBody } from '../../../supabase/functions/_shared/email.js'
import { sendTransferEmail } from '../../../supabase/functions/_shared/registration/transfers.js'

const EVENT = { name: 'Wilczy Bieg <Nocny>', eventDate: '2026-11-28', place: 'Wilków, stadion' }
const COMP = { name: 'Bieg 10 km', startTime: '10:00' }
const LINK = 'https://www.leszy.run/przekazanie#AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'
const all = (mail) => `${mail.subject}\n${mail.text}\n${mail.html}`

// No e-mail of a transfer names a bib, a partner or a voucher, or asks the runner to pay LESZY.RUN.
function assertNothingExtra(mail) {
  const s = all(mail)
  assert.doesNotMatch(s, /numer startowy|nr startowy|\bbib\b/i)
  assert.doesNotMatch(s, /partner|kod rabatowy|voucher/i)
  assert.doesNotMatch(s, /opłat\p{L}* za przekazanie|do zapłaty: [1-9]/iu)
}

describe('transferInviteEmail', () => {
  const mail = transferInviteEmail({ event: EVENT, senderFirstName: 'Ola', competition: COMP, link: LINK, until: '2026-11-20' })

  it('subject „<Imię> przekazuje Ci start — <nazwa>”', () => {
    assert.equal(mail.subject, 'Ola przekazuje Ci start — Wilczy Bieg <Nocny>')
  })
  it('carries the link with the token in the fragment, in text and html', () => {
    assert.ok(mail.text.includes(LINK))
    assert.ok(mail.html.includes(`href="${LINK}"`))
    assert.doesNotMatch(all(mail), /przekazanie\?/)
  })
  it('says the money is settled between the two people, outside LESZY.RUN', () => {
    assert.ok(mail.text.includes(MONEY_NOTE))
    assert.match(MONEY_NOTE, /między sobą, poza LESZY\.RUN/)
  })
  it('names the last day and the race facts', () => {
    assert.match(mail.text, /do 20\.11\.2026 włącznie/)
    assert.match(mail.text, /Konkurencja: Bieg 10 km/)
    assert.match(mail.text, /Start: 28\.11\.2026, godz\. 10:00/)
  })
  it('escapes the html', () => {
    assert.ok(mail.html.includes('Wilczy Bieg &lt;Nocny&gt;'))
    assert.ok(!mail.html.includes('<Nocny>'))
  })
  it('names no bib, partner or fee', () => assertNothingExtra(mail))
})

describe('transferAcceptedEmail (V-52)', () => {
  const mail = transferAcceptedEmail({ event: EVENT, senderFirstName: 'Ola', recipient: { firstName: 'Jan', lastName: 'Nowak' } })
  it('subject „Pakiet przejęła <Imię Nazwisko> — <nazwa>”', () => {
    assert.equal(mail.subject, 'Pakiet przejęła Jan Nowak — Wilczy Bieg <Nocny>')
  })
  it('greets the sender and names who took the package, by name only', () => {
    assert.match(mail.text, /^Cześć Ola,/)
    assert.match(mail.text, /Jan Nowak przejmuje Twój pakiet/)
    assert.doesNotMatch(all(mail), /@/)
  })
  it('names no bib, partner or fee', () => assertNothingExtra(mail))
})

describe('transferCancelledEmail (V-53)', () => {
  const mail = transferCancelledEmail({ event: EVENT, senderFirstName: 'Ola' })
  it('subject „Zaproszenie cofnięte — <nazwa>”', () => assert.equal(mail.subject, 'Zaproszenie cofnięte — Wilczy Bieg <Nocny>'))
  it('says the old link no longer works', () => assert.match(mail.text, /Link z poprzedniej wiadomości już nie działa/))
  it('names no bib, partner or fee', () => assertNothingExtra(mail))
})

describe('transferConfirmationEmail', () => {
  const mail = transferConfirmationEmail({
    event: { ...EVENT, url: 'https://www.leszy.run/events/wilczy' },
    person: { firstName: 'Jan', ageGroupLabel: 'M30' },
    competition: COMP,
  })
  it('subject „Jesteś na liście — <nazwa>”', () => assert.equal(mail.subject, 'Jesteś na liście — Wilczy Bieg <Nocny>'))
  it('lists the competition, category and start, and the money note', () => {
    assert.match(mail.text, /Kategoria: M30/)
    assert.match(mail.text, /Konkurencja: Bieg 10 km/)
    assert.ok(mail.text.includes(MONEY_NOTE))
  })
  it('names no bib, partner or fee', () => assertNothingExtra(mail))
})

describe('V-58 a transferred line in the order e-mails', () => {
  const order = { id: 'o1', entryTotal: 6000, total: 6000, paidTransactionId: 'T1', paidAt: '2026-11-01T10:00:00Z' }
  it('the order confirmation shows the recipient by name as „przejął(-ęła) pakiet”, nothing else of theirs', () => {
    const mail = orderConfirmationEmail({
      event: EVENT, order, organizer: { name: 'Klub' },
      lines: [{ transferred: true, firstName: 'Jan', lastName: 'Nowak', email: 'jan@example.com', competition: 'Bieg 10 km', ageGroupLabel: 'M30', startTime: '10:00' }],
    })
    assert.match(mail.text, /- Jan Nowak — przejął\(-ęła\) pakiet\n/)
    assert.doesNotMatch(all(mail), /jan@example\.com|M30/)
  })
  it('a team confirmation marks a captain whose package was handed on', () => {
    const mail = teamConfirmationEmail({
      event: EVENT, team: { name: 'Wilki', competition: 'Sztafeta' }, link: 'https://x',
      members: [{ firstName: 'Jan', lastName: 'Nowak', role: 'self', transferred: true }],
    })
    assert.match(mail.text, /Jan Nowak — kapitan, przejął\(-ęła\) pakiet/)
  })
})

describe('transfer refusals: every code the transfer RPCs raise has an answer (no 500s)', () => {
  it('covers each RAISE of 20261103150000 and maps 40001 to one retry', async () => {
    const { readFileSync } = await import('node:fs')
    const { TRANSFER_REFUSALS, isRetry } = await import('../../../supabase/functions/_shared/registration/transfers.js')
    const sql = readFileSync(new URL('../../../supabase/migrations/20261103150000_registration_transfers.sql', import.meta.url), 'utf8')
    const codes = new Set([...sql.matchAll(/RAISE EXCEPTION '([a-z_]+)'/g)].map((m) => m[1]))
    // cancel_registration's own codes are organizer-entry-action's (its `cancel` action).
    for (const own of ['already_cancelled', 'below_team_min', 'transferred']) codes.delete(own)
    assert.ok(codes.size >= 20, `found ${codes.size} codes`)
    for (const code of codes) {
      assert.ok(TRANSFER_REFUSALS[code], `no answer for ${code}`)
      const [status] = TRANSFER_REFUSALS[code]
      assert.ok(status >= 400 && status < 500, `${code} → ${status}`)
    }
    assert.equal(isRetry({ code: '40001', message: 'transfer_retry' }), true)
    assert.equal(isRetry({ code: 'P0001', message: 'gone' }), false)
  })
  it('the brief\'s 409 copy', async () => {
    const { TRANSFER_REFUSALS: R } = await import('../../../supabase/functions/_shared/registration/transfers.js')
    assert.deepEqual(R.gone, [409, 'Ten link został już użyty, cofnięty albo wygasł.'])
    assert.deepEqual(R.duplicate, [409, 'Masz już opłacony start na tych zawodach.'])
    assert.deepEqual(R.pending_elsewhere, [409, 'Masz nieopłacone zgłoszenie na te zawody razem z innymi osobami. Opłać je albo poproś o anulowanie.'])
    assert.deepEqual(R.recipient_minor, [409, 'Pakiet może przejąć tylko osoba pełnoletnia.'])
    assert.deepEqual(R.price_differs, [409, 'Wybierz konkurencję w tej samej cenie.'])
    assert.deepEqual(R.transfer_off, [409, 'Przekazanie pakietu nie jest już możliwe.'])
    assert.deepEqual(R.pending_exists, [409, 'Zaproszenie już wysłane. Cofnij je, aby wysłać nowe.'])
  })
})

describe('transferAllowed (ruling 3, §5.4)', async () => {
  const { transferAllowed } = await import('../../../supabase/functions/_shared/registration/transfers.js')
  const NOW = new Date('2026-11-10T12:00:00Z')
  const settings = { event_date: '2026-11-28', transfer_enabled: true, transfer_until: '2026-11-20' }
  const reg = { id: 'r1', profile_id: 'u1', status: 'confirmed', email: 'a@b.pl', birth_date: '1990-01-01', guardian_profile_id: null, team_id: null }
  const table = [
    ['own adult entry', reg, settings, true],
    ['another person\'s entry', { ...reg, profile_id: 'u2' }, settings, false],
    ['not confirmed', { ...reg, status: 'pending_payment' }, settings, false],
    ['a child (17 on race day)', { ...reg, birth_date: '2008-11-29' }, settings, false],
    ['18 on race day', { ...reg, birth_date: '2008-11-28' }, settings, true],
    ['a guardian\'s row', { ...reg, guardian_profile_id: 'g' }, settings, false],
    ['transfers off', reg, { ...settings, transfer_enabled: false }, false],
    ['past transfer_until', reg, { ...settings, transfer_until: '2026-11-09' }, false],
    ['on transfer_until', reg, { ...settings, transfer_until: '2026-11-10' }, true],
  ]
  for (const [name, r, s, want] of table) {
    it(`${name} → ${want}`, () => assert.equal(transferAllowed(r, s, 'u1', { now: NOW }), want))
  }
  it('a team member only as captain', () => {
    const member = { ...reg, team_id: 't' }
    assert.equal(transferAllowed(member, settings, 'u1', { team: { captain_registration_id: 'r9' }, now: NOW }), false)
    assert.equal(transferAllowed(member, settings, 'u1', { team: { captain_registration_id: 'r1' }, now: NOW }), true)
  })
})

describe('transferByOrganizerEmail (M-2, ruling N-1)', () => {
  const mail = transferByOrganizerEmail({
    event: EVENT, holderFirstName: 'Ola', organizer: { name: 'Zatyrani', contactEmail: 'biuro@zatyrani.pl' },
  })
  it('subject „Pakiet przekazany — <nazwa>”, the organizer named, the organizer to write to', () => {
    assert.equal(mail.subject, 'Pakiet przekazany — Wilczy Bieg <Nocny>')
    assert.match(mail.text, /^Cześć Ola,/)
    assert.match(mail.text, /\(Zatyrani\) przekazał Twój pakiet innej osobie\./)
    assert.match(mail.text, /biuro@zatyrani\.pl/)
  })
  it('N-1: never names the new holder, even when a caller passes them (the old holder did not choose them)', () => {
    const passed = transferByOrganizerEmail({
      event: EVENT, holderFirstName: 'Ola', recipient: { firstName: 'Jan', lastName: 'Nowak', email: 'jan@x.pl' },
      organizer: { name: 'Zatyrani' },
    })
    assert.doesNotMatch(all(passed), /Jan|Nowak|jan@x\.pl/)
  })
  it('names no bib, partner or fee', () => assertNothingExtra(mail))
})

describe('click tracking: a token link is never rewritten (review M-5)', () => {
  it('the invite and the consent request ask for no click tracking; other e-mails leave it alone', () => {
    const invite = transferInviteEmail({ event: EVENT, senderFirstName: 'Ola', competition: COMP, link: LINK, until: '2026-11-20' })
    const consent = consentRequestEmail({
      event: EVENT, person: { firstName: 'Piotr' }, registeredBy: 'Ola', competition: COMP,
      link: 'https://www.leszy.run/zgoda#x', dataInfoUrl: 'https://www.leszy.run/events/w/informacja-o-danych',
    })
    assert.equal(invite.noTracking, true)
    assert.equal(consent.noTracking, true)
    assert.equal(paymentReminderEmail({ event: EVENT, order: { total: 100 }, payUrl: 'https://x' }).noTracking, undefined)
  })
  it('the SendGrid payload sets tracking_settings.click_tracking.enable = false for such a message', () => {
    const body = buildSendGridBody({ to: 'a@b.pl', subject: 's', text: 't', html: '<p>t</p>', noTracking: true }, 'from@leszy.run')
    assert.deepEqual(body.tracking_settings, { click_tracking: { enable: false, enable_text: false } })
    assert.equal(body.noTracking, undefined, 'the flag itself never reaches SendGrid')
    const plain = buildSendGridBody({ to: 'a@b.pl', subject: 's', text: 't' }, 'from@leszy.run')
    assert.equal(plain.tracking_settings, undefined)
  })
})

/** A stand-in for the admin client: records each statement on `transfers` / `operator_alerts`. */
function fakeAdmin({ claimed = true } = {}) {
  const calls = []
  const admin = {
    calls,
    from(table) {
      const q = { table, op: null, values: null, filters: [] }
      calls.push(q)
      const chain = {
        update(values) { q.op = 'update'; q.values = values; return chain },
        upsert(values, opts) { q.op = 'upsert'; q.values = values; q.opts = opts; return chain },
        eq(k, v) { q.filters.push(['eq', k, v]); return chain },
        is(k, v) { q.filters.push(['is', k, v]); return chain },
        select() { q.select = true; return chain },
        then(resolve) {
          const isClaim = q.op === 'update' && q.filters.some(([f]) => f === 'is')
          resolve({ data: isClaim ? (claimed ? [{ id: 't1' }] : []) : null, error: null })
        },
      }
      return chain
    },
  }
  return admin
}
const MAIL = { subject: 's', text: 't', html: 'h' }
const releases = (admin) => admin.calls.filter((c) => c.op === 'update' && c.values.accepted_emailed_at === null)
const alerts = (admin) => admin.calls.filter((c) => c.table === 'operator_alerts')

describe('sendTransferEmail: claim, send, and what a failure does (review I-1)', () => {
  it('sent → true, the claim stays, no alert', async () => {
    const admin = fakeAdmin()
    assert.equal(await sendTransferEmail(admin, 't1', 'accepted_emailed_at', 'a@b.pl', MAIL, { send: async () => ({ ok: true }) }), true)
    assert.equal(releases(admin).length, 0)
    assert.equal(alerts(admin).length, 0)
  })
  it('already claimed by somebody else → false, nothing sent', async () => {
    const admin = fakeAdmin({ claimed: false })
    let sent = 0
    assert.equal(await sendTransferEmail(admin, 't1', 'accepted_emailed_at', 'a@b.pl', MAIL, { send: async () => { sent++; return { ok: true } } }), false)
    assert.equal(sent, 0)
  })
  it('a certain failure (non-2xx) gives the claim back, no alert', async () => {
    const admin = fakeAdmin()
    assert.equal(await sendTransferEmail(admin, 't1', 'accepted_emailed_at', 'a@b.pl', MAIL, { send: async () => ({ ok: false, status: 500 }) }), false)
    assert.equal(releases(admin).length, 1)
    assert.deepEqual(releases(admin)[0].filters, [['eq', 'id', 't1']])
    assert.equal(alerts(admin).length, 0)
  })
  it('an unknown outcome keeps the claim and alerts with the transfer id and column only', async () => {
    const admin = fakeAdmin()
    const send = async () => { const e = new Error('SendGrid: no answer in 10000 ms'); e.deliveryUnknown = true; throw e }
    assert.equal(await sendTransferEmail(admin, 't1', 'accepted_emailed_at', 'a@b.pl', MAIL, { send }), false)
    assert.equal(releases(admin).length, 0)
    const [alert] = alerts(admin)
    assert.equal(alert.values.kind, 'transfer_email_unknown')
    assert.deepEqual(alert.values.payload, { transferId: 't1', column: 'accepted_emailed_at' })
    assert.equal(alert.values.order_id, null)
  })
  it('the job\'s own re-send (claimed) never gives the claim back: it alerts transfer_email_failed', async () => {
    const admin = fakeAdmin()
    assert.equal(await sendTransferEmail(admin, 't1', 'accepted_emailed_at', 'a@b.pl', MAIL,
      { claimed: true, send: async () => ({ ok: false, status: 500 }) }), false)
    assert.equal(releases(admin).length, 0)
    assert.equal(alerts(admin)[0].values.kind, 'transfer_email_failed')
  })
})
