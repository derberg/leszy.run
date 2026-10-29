// Plan 4, task 4a: the group sign-up endpoints (register-free, create-order) and the consent
// request e-mails. Scenarios G-28, G-29, G-30 and G-33 in docs/registration/scenario-matrix.md.
// LOCAL stack plus the mocked dpay; every event and address is random.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { CAPTURE_PORT } from './helpers/emailCaptureServer.js'
import { lastCodeFor, messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { dpayReset, dpayTransactions, payMock, replayIpn, startDpayMock } from './helpers/dpayControl.js'
import { consentIds, db, expireNow, one, orderOf, registrationsOf, rows, runnerEmail } from './helpers/orders.js'
import { BIEG, DZIECI, groupTotal } from './helpers/groups.js'
import { hashToken } from '../../supabase/functions/_shared/registration/tokens.js'
import { RETIRED_EMAIL_MESSAGE } from '../../supabase/functions/_shared/deletedEmails.js'

const DUPLICATE = 'Ten adres e-mail jest już zapisany na te zawody.'
const MINOR_SELF = 'Osobę niepełnoletnią zapisuje rodzic lub opiekun.'
const PENDING_ORDER = 'Masz już nieopłacone zgłoszenie na te zawody.'
const CONSENT_SUBJECT = /^Zapisano Cię na .+ — zaakceptuj regulamin$/
const TOKEN_RE = /\/zgoda#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/

let owner, stopCapture, stopMock
before(async () => {
  stopCapture = await startCapture()
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => {
  if (stopMock) await stopMock()
  if (stopCapture) await stopCapture()
})
beforeEach(async () => { await dpayReset() })

const freeFamily = (c1 = 50, c2 = 50) => createPublishedFreeEvent(owner, { competitions: [BIEG(c1), DZIECI(c2)] })
const paidFamily = (c1 = 50, c2 = 50) => createPublishedPaidEvent(owner, {
  prices: { 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 2000 }, competitions: [BIEG(c1), DZIECI(c2)],
})

// A random documentation-range address per call keeps the per-IP throttles out of the way.
const ip = () => `198.51.100.${crypto.randomInt(1, 255)}`

async function call(fn, body, session = null) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...(session ? { cookie: session.cookie } : {}) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json, setCookie: res.headers.get('set-cookie') }
}

const grownUp = (email, over = {}) => ({
  firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200', ...over,
})
const child = (over = {}) => ({
  firstName: 'Zosia', lastName: 'Leśna', birthDate: '2016-05-05', gender: 'K', phone: '600100200', ...over,
})

/** A group body: people [{ categoryId, person, guardianConsent? }]. */
async function groupBody(event, people, over = {}) {
  return { people, acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true, ...over }
}

/** Self 9 km, another adult 9 km, a child in the kids' run. */
function family(event, me, partner, childOver = {}) {
  const [c9, kids] = event.categoryIds
  return [
    { categoryId: c9, person: grownUp(me) },
    { categoryId: c9, person: grownUp(partner, { firstName: 'Piotr', lastName: 'Leśny', gender: 'M' }) },
    { categoryId: kids, person: child(childOver), guardianConsent: true },
  ]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitForMail(email, n = 1) {
  for (let i = 0; i < 40; i++) {
    const msgs = await messagesTo(email)
    if (msgs.length >= n) return msgs
    await sleep(250)
  }
  return messagesTo(email)
}
const consentMails = async (email) => (await messagesTo(email)).filter((m) => CONSENT_SUBJECT.test(m.subject))
const eventName = async (eventId) => (await one('registration_settings', { event_id: eventId })).name
const byEvent = (eventId) => rows('registrations', { event_id: eventId })

async function waitFor(check, what) {
  for (let i = 0; i < 80; i++) {
    if (await check()) return
    await sleep(250)
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** issueConsentRequests run here, as the function runs it (its e-mail goes to this slot's capture). */
async function replayIssue(ids) {
  const env = { EMAIL_CAPTURE_URL: `http://127.0.0.1:${CAPTURE_PORT}/send`, PUBLIC_SITE_URL: 'http://localhost:5173' }
  const hadDeno = 'Deno' in globalThis
  const prev = globalThis.Deno
  globalThis.Deno = { env: { get: (k) => env[k] } }
  try {
    const { issueConsentRequests } = await import('../../supabase/functions/_shared/registration/consentRequests.js')
    return await issueConsentRequests(db(), ids)
  } finally {
    if (hadDeno) globalThis.Deno = prev
    else delete globalThis.Deno
  }
}

/** The consent e-mail's token matches the stored hash, and the link is /zgoda#<token>. */
async function assertConsentLink(mail, registrationId) {
  const m = mail.text.match(TOKEN_RE)
  assert.ok(m, `a /zgoda#<token> link: ${mail.text}`)
  assert.ok(mail.text.includes(`http://localhost:5173/zgoda#${m[1]}`))
  const [req] = await rows('consent_requests', { registration_id: registrationId })
  assert.equal(req.token_hash, await hashToken(m[1]))
}

// ---------------------------------------------------------------- G-28 free family

test('G-28 a free family via register-free: one confirmation to the payer listing 3 people, one consent e-mail to the adult, none to anyone else', async () => {
  const event = await freeFamily()
  const [c9, kids] = event.categoryIds
  const me = runnerEmail('pay')
  const partner = runnerEmail('adult')
  const payer = await sessionFor(me)

  const r = await call('register-free', await groupBody(event, family(event, me, partner)), payer)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.deepEqual(r.body.data.registrations.map((x) => [x.competition, typeof x.id]), [
    ['Bieg 9 km', 'string'], ['Bieg 9 km', 'string'], ['Bieg dzieci 1 km', 'string'],
  ])

  const regs = await byEvent(event.eventId)
  assert.equal(regs.length, 3)
  const self = regs.find((x) => x.email === me)
  const added = regs.find((x) => x.email === partner)
  const kid = regs.find((x) => x.email === null)
  // The self row is the buyer's own: their account, accepted. The added adult awaits consent.
  assert.equal(self.profile_id, payer.profileId)
  assert.equal(self.consent_state, 'accepted')
  assert.equal(added.profile_id, null)
  assert.equal(added.consent_state, 'awaiting')
  assert.equal(kid.category_id, kids)
  assert.equal(kid.guardian_profile_id, payer.profileId)
  assert.equal(kid.guardian_email, me)
  assert.equal(kid.guardian_name, 'Ola Leśna')
  for (const x of regs) assert.equal(x.registered_by_profile_id, payer.profileId)
  assert.equal((await one('competitions', { category_id: c9 })).taken, 2)

  const name = await eventName(event.eventId)
  const mine = await waitForMail(me)
  assert.deepEqual(mine.map((m) => m.subject), [`Jesteście na liście — ${name}`])
  for (const s of ['Ola Leśna', 'Piotr Leśny', 'Zosia Leśna', 'Bieg dzieci 1 km']) assert.ok(mine[0].text.includes(s), s)

  const asked = await waitForMail(partner)
  assert.equal(asked.length, 1, 'the added adult gets the consent e-mail only, no confirmation')
  assert.equal(asked[0].subject, `Zapisano Cię na ${name} — zaakceptuj regulamin`)
  assert.ok(asked[0].text.includes('Ola Leśna'), 'names who registered them (Art. 14)')
  assert.ok(asked[0].text.includes('Bieg 9 km'))
  await assertConsentLink(asked[0], added.id)
  assert.equal((await rows('consent_requests', { registration_id: self.id })).length, 0)
  assert.equal((await rows('consent_requests', { registration_id: kid.id })).length, 0)

  // A replay issues nothing and sends nothing.
  assert.equal(await replayIssue(regs.map((x) => x.id)), 0)
  await sleep(500)
  assert.equal((await consentMails(partner)).length, 1)
  assert.equal((await messagesTo(me)).length, 1)
})

test('G-28 „Nie startuję”: the buyer verifies their own address by code, registers an adult and a child, and gets a session; no row is theirs', async () => {
  const event = await freeFamily()
  const [c9, kids] = event.categoryIds
  const buyerEmail = runnerEmail('buyer')
  const partner = runnerEmail('adult')
  const res = await fetch(`${localEnv().functionsUrl}/auth-request-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: buyerEmail }),
  })
  assert.equal(res.status, 200)
  let code = null
  for (let i = 0; i < 20 && !code; i++) { code = await lastCodeFor(buyerEmail); if (!code) await sleep(250) }
  assert.ok(code)

  const people = [
    { categoryId: c9, person: grownUp(partner, { firstName: 'Piotr', lastName: 'Leśny', gender: 'M' }) },
    { categoryId: kids, person: child(), guardianConsent: true },
  ]
  const r = await call('register-free', await groupBody(event, people, {
    buyer: { firstName: 'Ewa', lastName: 'Leśna', email: buyerEmail }, code,
  }))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.match(r.setCookie ?? '', /^leszy_session=[0-9a-f]{64};/)
  const profile = await one('profiles', { email: buyerEmail })
  const regs = await byEvent(event.eventId)
  assert.equal(regs.length, 2)
  assert.ok(regs.every((x) => x.profile_id === null && x.registered_by_profile_id === profile.id))
  const kid = regs.find((x) => x.email === null)
  assert.equal(kid.guardian_name, 'Ewa Leśna')
  assert.equal(kid.guardian_email, buyerEmail)

  const name = await eventName(event.eventId)
  const toBuyer = (await waitForMail(buyerEmail, 2)).filter((m) => !/^\d{6}/.test(m.subject))
  assert.deepEqual(toBuyer.map((m) => m.subject), [`Jesteście na liście — ${name}`])
  assert.ok(toBuyer[0].text.startsWith('Cześć Ewa,'))
  const asked = await waitForMail(partner)
  assert.equal(asked.length, 1)
  assert.ok(asked[0].text.includes('Ewa Leśna'))
})

// ---------------------------------------------------------------- the self is the buyer

test('G-28 the self is the buyer: a session cannot sign up someone else as „Twoje dane”, nor name another buyer without their code', async () => {
  const event = await freeFamily()
  const [c9] = event.categoryIds
  const me = runnerEmail('sess')
  const other = runnerEmail('other')
  const session = await sessionFor(me)

  // No buyer: card 1 is „Twoje dane”, so its address is the one that must be verified.
  const asOther = await call('register-free', await groupBody(event, [{ categoryId: c9, person: grownUp(other) }]), session)
  assert.equal(asOther.status, 401, JSON.stringify(asOther.body))
  assert.equal(asOther.body.code, 'code_required')

  // A buyer who is not the session's address needs that buyer's code.
  const otherBuyer = await call('register-free', await groupBody(event, [{ categoryId: c9, person: grownUp(me) }], {
    buyer: { firstName: 'Jan', lastName: 'Obcy', email: other },
  }), session)
  assert.equal(otherBuyer.status, 401, JSON.stringify(otherBuyer.body))
  assert.equal(otherBuyer.body.code, 'code_required')

  // The session's own address twice: one self at most, the second is a duplicate in the request.
  const twice = await call('register-free', await groupBody(event, [
    { categoryId: c9, person: grownUp(me) }, { categoryId: c9, person: grownUp(me.toUpperCase(), { firstName: 'Ala' }) },
  ]), session)
  assert.equal(twice.status, 400, JSON.stringify(twice.body))
  assert.equal(twice.body.code, 'invalid_person')
  assert.deepEqual(twice.body.people, { 1: { email: 'Ten adres jest już w tym zgłoszeniu.' } })
  assert.equal((await byEvent(event.eventId)).length, 0)
})

// ---------------------------------------------------------------- refusals of a group

test('G-28 group refusals: a minor self → invalid_group; a child without guardian consent → invalid_person; full:<id> names the competition; duplicate:<i> has the index; two events → 404', async () => {
  const event = await freeFamily(50, 1)
  const [c9, kids] = event.categoryIds
  const me = runnerEmail('ref')
  const session = await sessionFor(me)

  const minorSelf = await call('register-free', await groupBody(event, [{ categoryId: c9, person: grownUp(me, { birthDate: '2012-01-01' }) }]), session)
  assert.equal(minorSelf.status, 400, JSON.stringify(minorSelf.body))
  assert.deepEqual(minorSelf.body, { error: MINOR_SELF, code: 'invalid_group' })

  const noConsent = await call('register-free', await groupBody(event, [
    { categoryId: c9, person: grownUp(me) }, { categoryId: kids, person: child() },
  ]), session)
  assert.equal(noConsent.status, 400)
  assert.equal(noConsent.body.code, 'invalid_person')
  assert.deepEqual(noConsent.body.people, { 1: { guardianConsent: 'Zaznacz zgodę opiekuna.' } })

  const full = await call('register-free', await groupBody(event, [
    { categoryId: c9, person: grownUp(me) },
    { categoryId: kids, person: child(), guardianConsent: true },
    { categoryId: kids, person: child({ firstName: 'Jaś', gender: 'M' }), guardianConsent: true },
  ]), session)
  assert.equal(full.status, 409, JSON.stringify(full.body))
  assert.equal(full.body.code, 'full')
  assert.equal(full.body.categoryId, kids)
  assert.match(full.body.error, /Bieg dzieci 1 km/)
  assert.equal((await byEvent(event.eventId)).length, 0)
  assert.equal((await one('competitions', { category_id: c9 })).taken, 0)

  const partner = runnerEmail('dup')
  const first = await call('register-free', await groupBody(event, [{ categoryId: c9, person: grownUp(partner) }]), await sessionFor(partner))
  assert.equal(first.status, 201, JSON.stringify(first.body))
  const dup = await call('register-free', await groupBody(event, [
    { categoryId: c9, person: grownUp(me) }, { categoryId: c9, person: grownUp(partner, { firstName: 'Piotr' }) },
  ]), session)
  assert.equal(dup.status, 409, JSON.stringify(dup.body))
  assert.deepEqual(dup.body, { error: DUPLICATE, code: 'duplicate', index: 1 })

  const another = await freeFamily()
  const mixed = await call('register-free', await groupBody(event, [
    { categoryId: c9, person: grownUp(me) }, { categoryId: another.categoryIds[0], person: grownUp(runnerEmail('mx')) },
  ]), session)
  assert.equal(mixed.status, 404, JSON.stringify(mixed.body))
  assert.equal((await byEvent(event.eventId)).length, 1)
})

// ---------------------------------------------------------------- G-29 paid family

test('G-29 a paid family: no consent e-mail while pending; paid → one; a replayed IPN ×3 → still one; an expired order → none', async () => {
  const event = await paidFamily()
  const me = runnerEmail('ppay')
  const partner = runnerEmail('padult')
  const payer = await sessionFor(me)
  const people = family(event, me, partner)
  const total = groupTotal(event, [{ categoryId: people[0].categoryId }, { categoryId: people[1].categoryId }, { categoryId: people[2].categoryId }])
  const r = await call('create-order', await groupBody(event, people, { supportChoice: false, displayedTotal: total }), payer)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const { orderId } = r.body.data
  const order = await orderOf(orderId)
  assert.equal(order.total, total)
  assert.equal(order.entry_total, 6000 + 6000 + 2000)
  const regs = await registrationsOf(orderId)
  const added = regs.find((x) => x.email === partner)
  assert.equal(added.consent_state, 'awaiting')
  assert.equal(added.status, 'pending_payment')

  await sleep(750)
  assert.deepEqual(await messagesTo(partner), [], 'nothing while the order waits for payment')
  assert.equal(await replayIssue(regs.map((x) => x.id)), 0, 'an unpaid registration gets no request')

  const [txn] = await dpayTransactions()
  await payMock(txn.id, 'paid')
  await waitFor(async () => (await orderOf(orderId)).status === 'paid', 'payment')
  const name = await eventName(event.eventId)
  const asked = await waitForMail(partner)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].subject, `Zapisano Cię na ${name} — zaakceptuj regulamin`)
  await assertConsentLink(asked[0], added.id)
  const paid = (await waitForMail(me)).map((m) => m.subject)
  assert.deepEqual(paid, [`Opłacone — ${name}`], 'the confirmation goes to the payer only')

  for (let i = 0; i < 3; i++) await replayIpn(txn.id, { times: 1 })
  await sleep(1000)
  assert.equal((await consentMails(partner)).length, 1)
  assert.equal((await rows('consent_requests', { registration_id: added.id })).length, 1)

  // A second family whose order expires unpaid: no consent request, no e-mail.
  const other = runnerEmail('exp')
  const late = await call('create-order', await groupBody(event, family(event, runnerEmail('epay'), other), {
    supportChoice: false, displayedTotal: total,
  }), await sessionFor(runnerEmail('ebuyer')))
  // The session is not card 1's address: card 1 is „Twoje dane”, so the code is asked for.
  assert.equal(late.status, 401)
  const me2 = runnerEmail('epay2')
  const late2 = await call('create-order', await groupBody(event, family(event, me2, other, { firstName: 'Jaś', gender: 'M' }), {
    supportChoice: false, displayedTotal: total,
  }), await sessionFor(me2))
  assert.equal(late2.status, 201, JSON.stringify(late2.body))
  assert.ok(await expireNow(late2.body.data.orderId) >= 1)
  const expiredRegs = await registrationsOf(late2.body.data.orderId)
  assert.equal(await replayIssue(expiredRegs.map((x) => x.id)), 0)
  await sleep(500)
  assert.deepEqual(await messagesTo(other), [])
})

test('G-29 create-order for a group: price_changed prices each person by their own competition; pending_order covers every adult address (D4-27)', async () => {
  const event = await paidFamily()
  const me = runnerEmail('pc')
  const partner = runnerEmail('pcadult')
  const payer = await sessionFor(me)
  const people = family(event, me, partner)
  const total = groupTotal(event, people.map((p) => ({ categoryId: p.categoryId })))

  const off = await call('create-order', await groupBody(event, people, { supportChoice: false, displayedTotal: total + 1 }), payer)
  assert.equal(off.status, 409, JSON.stringify(off.body))
  assert.equal(off.body.code, 'price_changed')
  assert.equal(off.body.amounts.entryTotal, 14000)
  assert.equal(off.body.amounts.total, total)

  const ok = await call('create-order', await groupBody(event, people, { supportChoice: false, displayedTotal: total }), payer)
  assert.equal(ok.status, 201, JSON.stringify(ok.body))

  // The same buyer, a new group whose second person is the partner already in that pending order.
  const again = [
    { categoryId: event.categoryIds[0], person: grownUp(me) },
    { categoryId: event.categoryIds[0], person: grownUp(partner, { firstName: 'Piotr', lastName: 'Leśny', gender: 'M' }) },
  ]
  const twoTotal = groupTotal(event, again.map((p) => ({ categoryId: p.categoryId })))
  const pending = await call('create-order', await groupBody(event, [again[1], { categoryId: event.categoryIds[0], person: grownUp(runnerEmail('new'), { firstName: 'Nowa' }) }], {
    buyer: { firstName: 'Ola', lastName: 'Leśna', email: me }, supportChoice: false, displayedTotal: twoTotal,
  }), payer)
  assert.equal(pending.status, 409, JSON.stringify(pending.body))
  assert.deepEqual(pending.body, { error: PENDING_ORDER, code: 'pending_order', orderId: ok.body.data.orderId })
  assert.equal((await rows('orders', { event_id: event.eventId })).length, 1)
})

// ---------------------------------------------------------------- G-30 retired address

test('G-30 an added adult whose address is retired → 403 email_retired with that person\'s index, no rows', async () => {
  const event = await freeFamily()
  const me = runnerEmail('ret')
  const gone = runnerEmail('gone')
  const hash = crypto.createHash('sha256').update(gone).digest('hex')
  const { error } = await db().from('deleted_email_hashes').upsert({ email_hash: hash }, { onConflict: 'email_hash' })
  assert.ifError(error)

  const r = await call('register-free', await groupBody(event, family(event, me, gone)), await sessionFor(me))
  assert.equal(r.status, 403, JSON.stringify(r.body))
  assert.deepEqual(r.body, { error: RETIRED_EMAIL_MESSAGE, code: 'email_retired', index: 1 })
  assert.equal((await byEvent(event.eventId)).length, 0)

  const paid = await paidFamily()
  const me2 = runnerEmail('ret2')
  const people = family(paid, me2, gone)
  const o = await call('create-order', await groupBody(paid, people, {
    supportChoice: false, displayedTotal: groupTotal(paid, people.map((p) => ({ categoryId: p.categoryId }))),
  }), await sessionFor(me2))
  assert.equal(o.status, 403, JSON.stringify(o.body))
  assert.deepEqual(o.body, { error: RETIRED_EMAIL_MESSAGE, code: 'email_retired', index: 1 })
  assert.equal((await rows('orders', { event_id: paid.eventId })).length, 0)
})

// ---------------------------------------------------------------- G-33 legacy bodies

test('G-33 the legacy one-person bodies keep their answers: field errors under `fields`, a retired address without an index, „w tej konkurencji”', async () => {
  const event = await freeFamily(1)
  const [c9] = event.categoryIds
  const me = runnerEmail('leg')
  const session = await sessionFor(me)
  const legacy = async (person, over = {}) => ({
    categoryId: c9, person, acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true, ...over,
  })
  const bad = await call('register-free', await legacy(grownUp(me, { gender: 'X' })), session)
  assert.equal(bad.status, 400)
  assert.deepEqual(bad.body.fields, { gender: 'Wybierz płeć.' })

  assert.equal((await call('register-free', await legacy(grownUp(me)), session)).status, 201)
  const other = runnerEmail('leg2')
  const full = await call('register-free', await legacy(grownUp(other)), await sessionFor(other))
  assert.equal(full.status, 409)
  assert.deepEqual(full.body, { error: 'Brak wolnych miejsc w tej konkurencji.', code: 'full' })
})
