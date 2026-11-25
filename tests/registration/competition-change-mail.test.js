// Competition change, task 6: the e-mails of a surcharge and of the move it pays for, through the
// settle path (settleConfirmOutcome) and the registration-jobs function. LOCAL stack + mock dpay.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { dpayMode, dpayReset, payMock, startDpayMock } from './helpers/dpayControl.js'
import { CAPTURE_PORT } from './helpers/emailCaptureServer.js'
import { DPAY_MOCK_PORT } from './helpers/dpayMock.js'
import { attemptFor, confirmOk, db, expireNow, one, orderOf, runnerEmail } from './helpers/orders.js'
import { paidEntry } from './helpers/transfers.js'
import { surchargeOk } from './helpers/competitionChange.js'
import { dpayConfig, registerTransaction } from '../../supabase/functions/_shared/dpay.js'
import { settleConfirmOutcome } from '../../supabase/functions/_shared/registration/orderFlow.js'
import {
  sendCompetitionChanged, sendSurchargeEmail,
} from '../../supabase/functions/_shared/registration/competitionChangeMail.js'

const JOBS_SECRET = readFileSync(new URL('./functions.env', import.meta.url), 'utf8')
  .match(/^REGISTRATION_JOBS_SECRET=(.*)$/m)?.[1]?.trim()
const nodeCfg = () => dpayConfig({
  DPAY_SERVICE: 'mock-service', DPAY_SECRET: 'mock-secret',
  DPAY_API_BASE: `http://127.0.0.1:${DPAY_MOCK_PORT}`, DPAY_PANEL_BASE: `http://127.0.0.1:${DPAY_MOCK_PORT}`,
  DPAY_IPN_URL: `${localEnv().url}/functions/v1/dpay-ipn`, PUBLIC_SITE_URL: 'http://localhost:5173',
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const HOUR = 3_600_000

// The e-mail code reads Deno.env: in node it goes to this slot's capture server, as in the functions.
const DENO_ENV = { EMAIL_CAPTURE_URL: `http://127.0.0.1:${CAPTURE_PORT}/send`, PUBLIC_SITE_URL: 'http://localhost:5173' }

let owner, stopCapture, stopMock
before(async () => {
  localEnv()
  globalThis.Deno = { env: { get: (k) => DENO_ENV[k] } }
  stopCapture = await startCapture()
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => {
  delete globalThis.Deno
  if (stopMock) await stopMock()
  if (stopCapture) await stopCapture()
})

async function jobs() {
  const res = await fetch(`${localEnv().functionsUrl}/registration-jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-jobs-secret': JOBS_SECRET }, body: '{}',
  })
  assert.equal(res.status, 200)
  return (await res.json()).data
}
async function mailTo(email, n = 1) {
  for (let i = 0; i < 30; i++) {
    const m = await messagesTo(email)
    if (m.length >= n) return m
    await sleep(200)
  }
  return messagesTo(email)
}
const setOrder = async (id, values) => {
  const { error } = await db().from('orders').update(values).eq('id', id)
  if (error) throw error
}

/** 9 km 60 zł → 21 km 80 zł: a paid entry with a pending 20 zł surcharge. */
async function withSurcharge({ capacity21 = 50 } = {}) {
  const event = await createPublishedPaidEvent(owner, {
    competitions: [
      { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 },
      { name: 'Bieg 21 km', discipline: 'run', distanceLabel: '21 km', startTime: '09:30', capacity: capacity21 },
    ],
    prices: { 'Bieg 9 km': 6000, 'Bieg 21 km': 8000 },
  })
  const [c9, c21] = event.categoryIds
  const a = await paidEntry(event)
  const s = await surchargeOk(a.reg.id, c21, 2000)
  return { event, a, s, c9, c21 }
}

test('CC-50 a paid surcharge sends „Zmieniono konkurencję” to the runner and a different payer, once', async () => {
  const { a, s } = await withSurcharge()
  const payer = runnerEmail('payer')
  await setOrder(s.orderId, { buyer_email: payer })
  const att = await attemptFor(s.orderId, 2000)
  const out = await confirmOk(s.orderId, att.txn, 2000)
  assert.equal(out.outcome, 'surcharge_moved')
  await settleConfirmOutcome(db(), nodeCfg(), { ...out, orderId: s.orderId, txn: att.txn })

  const runnerMail = (await mailTo(a.email))
  const changed = runnerMail.filter((m) => m.subject.startsWith('Zmieniono konkurencję'))
  assert.equal(changed.length, 1)
  assert.match(changed[0].text, /Bieg 9 km/)
  assert.match(changed[0].text, /Bieg 21 km/)
  assert.ok(!changed[0].text.includes(payer), "the payer's address is not in the mail")
  assert.equal((await mailTo(payer)).filter((m) => m.subject.startsWith('Zmieniono konkurencję')).length, 1)
  assert.ok((await orderOf(s.orderId)).confirmation_sent_at, 'claimed')

  // Replayed: claimed, so nothing is sent twice.
  await settleConfirmOutcome(db(), nodeCfg(), { ...out, orderId: s.orderId, txn: att.txn })
  assert.equal((await messagesTo(a.email)).filter((m) => m.subject.startsWith('Zmieniono konkurencję')).length, 1)
})

test('CC-50 one address that is both runner and payer gets one mail', async () => {
  const { a, s } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  const out = await confirmOk(s.orderId, att.txn, 2000)
  await settleConfirmOutcome(db(), nodeCfg(), { ...out, orderId: s.orderId, txn: att.txn })
  await sleep(300)
  assert.equal((await messagesTo(a.email)).filter((m) => m.subject.startsWith('Zmieniono konkurencję')).length, 1)
})

test('CC-51 a lost change notice is resent by the job 10 minutes after payment, once', async () => {
  const { a, s } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  assert.equal((await confirmOk(s.orderId, att.txn, 2000)).outcome, 'surcharge_moved')
  // The settle never ran (the function died): no stamp, paid 11 minutes ago.
  await setOrder(s.orderId, { paid_at: new Date(Date.now() - 11 * 60_000).toISOString() })
  const data = await jobs()
  assert.ok(data.surchargeConfirmationsResent >= 1)
  const m = (await mailTo(a.email)).filter((x) => x.subject.startsWith('Zmieniono konkurencję'))
  assert.equal(m.length, 1)
  await jobs()
  assert.equal((await messagesTo(a.email)).filter((x) => x.subject.startsWith('Zmieniono konkurencję')).length, 1)
})

test('CC-52 the surcharge request names the amount and links the order page; the job reminds once', async () => {
  const { a, s } = await withSurcharge()
  const sent = await sendSurchargeEmail(db(), s.orderId)
  assert.deepEqual(sent, { sent: true, error: null })
  const first = (await mailTo(a.email)).find((m) => m.subject.startsWith('Dopłata za zmianę konkurencji'))
  assert.ok(first)
  assert.match(first.text, /20,00 zł/)
  assert.ok(first.text.includes(`/zamowienie/${s.orderId}`))

  // A window over 24 h, past its half: the reminder is due.
  const day = 24 * HOUR
  await setOrder(s.orderId, {
    created_at: new Date(Date.now() - 5 * day).toISOString(), expires_at: new Date(Date.now() + 1 * day).toISOString(),
  })
  const data = await jobs()
  assert.ok(data.surchargeReminders >= 1)
  const reminders = (await mailTo(a.email, 2)).filter((m) => m.subject.startsWith('Przypomnienie: dopłata'))
  assert.equal(reminders.length, 1)
  await jobs()
  assert.equal((await messagesTo(a.email)).filter((m) => m.subject.startsWith('Przypomnienie: dopłata')).length, 1)
})

test('CC-53 an unpaid surcharge that expires: „Dopłata wygasła — zostajesz w <stara>” once', async () => {
  const { a, s } = await withSurcharge()
  await expireNow(s.orderId)
  assert.equal((await orderOf(s.orderId)).status, 'expired')
  // No unpaid dpay transaction exists, so no proof is awaited.
  const data = await jobs()
  assert.ok(data.surchargeExpiredNotices >= 1)
  const m = (await mailTo(a.email)).filter((x) => x.subject.startsWith('Dopłata wygasła'))
  assert.equal(m.length, 1)
  assert.equal(m[0].subject, 'Dopłata wygasła — zostajesz w Bieg 9 km')
  await jobs()
  assert.equal((await messagesTo(a.email)).filter((x) => x.subject.startsWith('Dopłata wygasła')).length, 1)
})

test('CC-54 a surcharge paid into a full competition is refunded with „Dopłata zwrócona” (full)', async () => {
  const { event, a, s, c9, c21 } = await withSurcharge()
  // The transaction starts while a place is free; somebody else then pays for the only one.
  // A real mock transaction, so dpay accepts the refund.
  await dpayReset()
  const reg = await registerTransaction(nodeCfg(), { orderId: s.orderId, grosze: 2000 })
  await dpayMode({ dropIpn: true })
  const att = await attemptFor(s.orderId, 2000, reg.transactionId)
  await payMock(reg.transactionId, 'paid')
  await db().from('competitions').update({ capacity: 1 }).eq('category_id', c21)
  await paidEntry(event, { categoryId: c21 })
  const out = await confirmOk(s.orderId, att.txn, 2000)
  assert.equal(out.outcome, 'late_refund')
  assert.equal(out.refund.reason, 'full')
  await settleConfirmOutcome(db(), nodeCfg(), { ...out, orderId: s.orderId, txn: att.txn })
  const m = (await mailTo(a.email)).filter((x) => x.subject === 'Dopłata zwrócona')
  assert.equal(m.length, 1)
  assert.match(m[0].text, /brak wolnych miejsc w Bieg 21 km/)
  assert.ok(!(await messagesTo(a.email)).some((x) => x.subject.startsWith('Płatność zwrócona')), 'no regular refund notice')
  assert.equal((await one('registrations', { id: a.reg.id })).category_id, c9, 'the entry stays')
})

test('CC-55 a cheaper move: sendCompetitionChanged names the refund; the entry\'s order buyer is mailed only when a refund went to their order', async () => {
  const { a, c9, c21 } = await withSurcharge()
  // Move the (still 9 km) entry nowhere cheaper in this fixture: use the helper directly.
  const payer = runnerEmail('orig-payer')
  await setOrder(a.orderId, { buyer_email: payer })
  const res = await sendCompetitionChanged(db(), { registrationId: a.reg.id, fromCategoryId: c21, toCategoryId: c9, refundGrosze: 2000 })
  assert.deepEqual(res, { sent: true, error: null })
  const own = (await mailTo(a.email)).find((m) => m.subject.startsWith('Zmieniono konkurencję'))
  assert.match(own.text, /Zwrot różnicy: 20,00 zł trafi na konto, z którego zapłacono\./)
  assert.ok(!own.text.includes(payer))
  await sleep(400)
  assert.equal((await messagesTo(payer)).length, 0, 'no refund names the order: its buyer hears nothing (L-1)')
})
