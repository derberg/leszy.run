// Plan 5, task 5a: the register-team endpoint and its e-mails, and startPaymentAttempt under it.
// Scenarios T-40, T-41, T-44, T-45 and T-46 in docs/registration/scenario-matrix.md. LOCAL stack
// plus the mocked dpay; every event and address is random.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { localEnv, resetThrottle, sessionFor, EDGE_PROXY } from './helpers/stack.js'
import { lastCodeFor, messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, makeClub } from './helpers/registrationFixtures.js'
import { dpayMode, dpayRefunds, dpayReset, dpayTransactions, payMock, replayIpn, startDpayMock } from './helpers/dpayControl.js'
import { competitionOf, consentIds, db, one, orderOf, orderOk, rows, runnerEmail } from './helpers/orders.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { STAFETA, freeTeamEvent, paidTeamEvent, setLegOrder, teamName } from './helpers/teams.js'
import { BIEG } from './helpers/groups.js'
import { RETIRED_EMAIL_MESSAGE } from '../../supabase/functions/_shared/deletedEmails.js'
import {
  CAPTAIN_MESSAGE, MEMBERS_CONSENT_MESSAGE, TEAM_NAME_MESSAGE, teamSizeMessage,
} from '../../supabase/functions/_shared/registration/team.js'

const DUPLICATE = 'Ta osoba jest już zapisana na te zawody.'
const NAME_TAKEN = 'Ta nazwa drużyny jest już zajęta.'
const PENDING_ORDER = 'Masz już nieopłacone zgłoszenie na te zawody.'
const NO_PLACES = 'Brak wolnych miejsc dla drużyn.'
const DPAY_DOWN = 'Nie udało się połączyć z operatorem płatności. Spróbuj ponownie.'
const CONSENT_SUBJECT = /^Zapisano Cię na .+ — zaakceptuj regulamin$/
const JOBS_SECRET = readFileSync(new URL('./functions.env', import.meta.url), 'utf8')
  .match(/^REGISTRATION_JOBS_SECRET=(.*)$/m)?.[1]?.trim()

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

// A random documentation-range address per call keeps the per-IP throttles out of the way.
const ip = () => `198.51.100.${crypto.randomInt(1, 255)}`

async function call(fn, body, session = null) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...EDGE_PROXY, 'x-forwarded-for': ip(), ...(session ? { cookie: session.cookie } : {}) },
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

/** The captain, one adult, two children (a surname of their own: two teams never share a child). */
const fourOf = (me, partner, surname = `Leśna${crypto.randomBytes(3).toString('hex')}`) => [
  { person: grownUp(me) },
  { person: grownUp(partner, { firstName: 'Piotr', lastName: 'Borowy', gender: 'M' }) },
  { person: child({ lastName: surname }), guardianConsent: true },
  { person: child({ firstName: 'Staś', lastName: surname, gender: 'M' }), guardianConsent: true },
]

/** A register-team body for the event's first competition. */
async function teamBody(event, members, over = {}) {
  const categoryId = event.categoryIds[0]
  return {
    categoryId, teamName: teamName(), members, membersConsent: true,
    acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true,
    displayedTotal: event.prices?.[categoryId] ?? 0, ...over,
  }
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
async function waitFor(check, what) {
  for (let i = 0; i < 80; i++) {
    if (await check()) return
    await sleep(250)
  }
  assert.fail(`timed out waiting for ${what}`)
}
const eventName = async (eventId) => (await one('registration_settings', { event_id: eventId })).name
const byEvent = (eventId) => rows('registrations', { event_id: eventId })
const teamsOf = (eventId) => rows('teams', { event_id: eventId })

/** A pending team through register-team → { event, me, partner, session, body, txn, ...data }. */
async function pendingTeam(opts = {}) {
  const event = opts.event ?? await paidTeamEvent(owner, opts.eventOpts)
  const me = runnerEmail('capt')
  const partner = runnerEmail('adult')
  const session = await sessionFor(me)
  const body = await teamBody(event, fourOf(me, partner), opts.body)
  const r = await call('register-team', body, session)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const txn = (await dpayTransactions()).at(-1)
  return { event, me, partner, session, body, txn, ...r.body.data }
}

// ---------------------------------------------------------------- T-40 free

test('T-40 a free team: 201 with no order; one confirmation to the captain with the four members and the squad link; one consent e-mail to the adult; none for the children', async () => {
  const event = await freeTeamEvent(owner)
  const me = runnerEmail('capt')
  const partner = runnerEmail('adult')
  const body = await teamBody(event, fourOf(me, partner, 'Leśna'))
  const r = await call('register-team', body, await sessionFor(me))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.deepEqual(Object.keys(r.body.data).sort(), ['status', 'teamId'])
  assert.equal(r.body.data.status, 'confirmed')
  const { teamId } = r.body.data

  const regs = await byEvent(event.eventId)
  assert.equal(regs.length, 4)
  assert.ok(regs.every((x) => x.team_id === teamId && x.status === 'confirmed' && x.order_id === null))
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)
  await assertSlotInvariant(event.categoryIds[0])

  const name = await eventName(event.eventId)
  const mine = await waitForMail(me)
  assert.deepEqual(mine.map((m) => m.subject), [`Drużyna ${body.teamName} jest na liście — ${name}`])
  for (const part of ['Ola Leśna', 'Piotr Borowy', 'Zosia Leśna', 'Staś Leśna', 'opiekun: kapitan', 'Zarządzaj składem']) {
    assert.ok(mine[0].text.includes(part), part)
  }
  const { slug } = await one('registration_settings', { event_id: event.eventId })
  assert.match(mine[0].text, new RegExp(`/events/${slug}/druzyna/${teamId}\\b`))
  assert.doesNotMatch(mine[0].text, /Opłacone|Razem|paragonem|numer startowy/i)

  const asked = await waitForMail(partner)
  assert.equal(asked.length, 1)
  assert.match(asked[0].subject, CONSENT_SUBJECT)
  assert.ok(asked[0].text.includes(`w drużynie ${body.teamName}`))
  assert.ok(asked[0].text.includes('Ola Leśna zapisał(a) Cię'))
  await sleep(300)
  assert.equal((await messagesTo(me)).length, 1, 'the captain gets no consent e-mail')
  // By id: an unfiltered read stops at PostgREST's 1000 rows, which a stack that was not reset passes.
  const { data: requests, error } = await db().from('consent_requests').select('id').in('registration_id', regs.map((x) => x.id))
  assert.ifError(error)
  assert.equal(requests.length, 1)
})

test('T-47 an adult member registered with name, birth date, gender and e-mail fills the rest on /zgoda before accepting', async () => {
  const event = await freeTeamEvent(owner)
  const me = runnerEmail('capt')
  const partner = runnerEmail('adult')
  const [captain, member, ...children] = fourOf(me, partner)
  const { phone: _phone, ...five } = member.person
  const r = await call('register-team', await teamBody(event, [captain, { person: five }, ...children]), await sessionFor(me))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const reg = (await byEvent(event.eventId)).find((x) => x.email === partner)
  assert.equal(reg.phone, null, 'nothing the member did not give is stored')

  const [asked] = await waitForMail(partner)
  assert.ok(asked.text.includes('uzupełnisz'), 'the e-mail says the rest is theirs to fill')
  const token = asked.text.match(TOKEN_RE)[1]
  const session = await sessionFor(partner)
  const read = await call('consent-request', { token }, session)
  assert.equal(read.status, 200, JSON.stringify(read.body))
  assert.deepEqual(read.body.data.missingFields, ['phone'])

  const body = { token, acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true }
  const refused = await call('accept-consent', body, session)
  assert.equal(refused.status, 422, JSON.stringify(refused.body))
  assert.equal(refused.body.code, 'details_required')
  assert.deepEqual(refused.body.fields, { phone: 'Podaj numer telefonu.' })
  assert.equal((await one('registrations', { id: reg.id })).consent_state, 'awaiting')

  const ok = await call('accept-consent', { ...body, edits: { phone: '600900100' } }, session)
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  const after = await one('registrations', { id: reg.id })
  assert.equal(after.consent_state, 'accepted')
  assert.equal(after.phone, '600900100')
})

test('T-40 a 0 zł fee on a paid event is confirmed at once, never reaches dpay, and the confirmation has no payment wording (P3-R9, D5-23)', async () => {
  const event = await paidTeamEvent(owner, { price: 0 })
  const me = runnerEmail('capt')
  const partner = runnerEmail('adult')
  const body = await teamBody(event, fourOf(me, partner))
  const r = await call('register-team', body, await sessionFor(me))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.data.status, 'confirmed')
  assert.ok(r.body.data.orderId, 'a 0 zł team on a paid event has an order')
  assert.equal(r.body.data.redirectUrl, undefined)
  assert.deepEqual(await dpayTransactions(), [])
  assert.equal((await orderOf(r.body.data.orderId)).status, 'paid')

  const name = await eventName(event.eventId)
  const mine = await waitForMail(me)
  assert.deepEqual(mine.map((m) => m.subject), [`Drużyna ${body.teamName} jest na liście — ${name}`])
  assert.doesNotMatch(mine[0].text, /Razem|paragonem|Transakcja/)
  assert.ok((await orderOf(r.body.data.orderId)).confirmation_sent_at)
  assert.equal((await waitForMail(partner)).length, 1)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)
})

// ---------------------------------------------------------------- T-41 paid

test('T-41 a paid team: nothing while pending; paid → the team confirmation with the payment facts and one consent e-mail; a replayed IPN ×3 → still one each', async () => {
  const { event, me, partner, body, txn, orderId, teamId, redirectUrl } = await pendingTeam()
  assert.ok(redirectUrl)
  assert.ok(teamId)
  const order = await orderOf(orderId)
  assert.equal(order.status, 'pending')
  assert.equal(order.total, 24000)
  assert.equal(txn.grosze, 24000)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 0)
  await sleep(500)
  assert.deepEqual(await messagesTo(partner), [], 'no consent e-mail while the team waits for payment')
  assert.deepEqual(await messagesTo(me), [])

  await payMock(txn.id, 'paid')
  await waitFor(async () => (await orderOf(orderId)).status === 'paid', 'payment')
  const name = await eventName(event.eventId)
  const mine = await waitForMail(me)
  assert.deepEqual(mine.map((m) => m.subject), [`Drużyna ${body.teamName} jest na liście — ${name}`])
  for (const part of ['Piotr Borowy', 'opiekun: kapitan', 'Zarządzaj składem', 'Razem', 'w imieniu i na rzecz Organizatora', 'nie jest paragonem']) {
    assert.ok(mine[0].text.includes(part), part)
  }
  assert.ok(mine[0].text.includes(`/druzyna/${teamId}`))
  const asked = await waitForMail(partner)
  assert.equal(asked.length, 1)
  assert.match(asked[0].subject, CONSENT_SUBJECT)
  assert.ok(asked[0].text.includes(`w drużynie ${body.teamName}`))
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)
  await assertSlotInvariant(event.categoryIds[0])

  for (let i = 0; i < 3; i++) await replayIpn(txn.id, { times: 1 })
  await sleep(1000)
  assert.equal((await messagesTo(me)).length, 1, 'one confirmation')
  assert.equal((await messagesTo(partner)).length, 1, 'one consent e-mail')
})

test('T-41 a paid team refunded for full: no confirmation, no consent e-mail, the refund e-mail, the whole fee back, the name free', async () => {
  const event = await paidTeamEvent(owner, { capacity: 1 })
  const first = await pendingTeam({ event })
  const late = await pendingTeam({ event })

  await payMock(first.txn.id, 'paid')
  await waitFor(async () => (await orderOf(first.orderId)).status === 'paid', 'the first payment')
  await payMock(late.txn.id, 'paid')
  await waitFor(async () => (await dpayRefunds()).some((x) => x.txnId === late.txn.id), 'the refund')

  assert.equal((await orderOf(late.orderId)).status, 'cancelled')
  const subjects = (await waitForMail(late.me)).map((m) => m.subject)
  assert.equal(subjects.length, 1)
  assert.match(subjects[0], /^Płatność zwrócona — /)
  await sleep(500)
  assert.deepEqual(await messagesTo(late.partner), [])
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)
  await assertSlotInvariant(event.categoryIds[0])
  assert.ok((await one('teams', { id: late.teamId })).released_at)
})

test('T-41 D5-25 a lost team confirmation is resent by registration-jobs as the same team e-mail', async () => {
  const { me, partner, body, txn, orderId, event } = await pendingTeam()
  await payMock(txn.id, 'paid')
  await waitFor(async () => (await orderOf(orderId)).confirmation_sent_at !== null, 'the confirmation')
  await waitForMail(partner)
  await db().from('orders')
    .update({ confirmation_sent_at: null, paid_at: new Date(Date.now() - 11 * 60_000).toISOString() }).eq('id', orderId)

  const res = await fetch(`${localEnv().functionsUrl}/registration-jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jobs-secret': JOBS_SECRET },
    body: '{}',
  })
  assert.equal(res.status, 200, await res.text())
  const mine = await waitForMail(me, 2)
  const name = await eventName(event.eventId)
  assert.deepEqual(mine.map((m) => m.subject), Array(2).fill(`Drużyna ${body.teamName} jest na liście — ${name}`))
})

// ---------------------------------------------------------------- T-44 refusals

test('T-44 team_name_taken → 409 with fields.teamName, a paid team too, in another spelling; nothing is written', async () => {
  const event = await freeTeamEvent(owner)
  const me = runnerEmail('capt')
  const name = teamName()
  const ok = await call('register-team', await teamBody(event, fourOf(me, runnerEmail('adult')), { teamName: name }), await sessionFor(me))
  assert.equal(ok.status, 201, JSON.stringify(ok.body))

  const other = runnerEmail('capt')
  const r = await call('register-team', await teamBody(event, fourOf(other, runnerEmail('adult')), { teamName: `  ${name.toUpperCase()} ` }), await sessionFor(other))
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.deepEqual(r.body, { error: NAME_TAKEN, code: 'team_name_taken', fields: { teamName: NAME_TAKEN } })
  assert.equal((await byEvent(event.eventId)).length, 4)
  assert.equal((await teamsOf(event.eventId)).length, 1)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)

  const paid = await pendingTeam({ eventOpts: {} })
  const third = runnerEmail('capt')
  const taken = await call('register-team', await teamBody(paid.event, fourOf(third, runnerEmail('adult')), { teamName: paid.body.teamName }), await sessionFor(third))
  assert.equal(taken.status, 409, JSON.stringify(taken.body))
  assert.equal(taken.body.code, 'team_name_taken', 'somebody else\'s pending team keeps its name')
})

test('T-44 duplicate:2 → errors[2].email, and past the daily cap the answer names nobody', async () => {
  const event = await freeTeamEvent(owner)
  const dup = runnerEmail('dup')
  const first = runnerEmail('capt')
  assert.equal((await call('register-team', await teamBody(event, [{ person: grownUp(first) }, { person: grownUp(dup) }]), await sessionFor(first))).status, 201)

  const me = runnerEmail('capt')
  const session = await sessionFor(me)
  const members = [{ person: grownUp(me) }, { person: grownUp(runnerEmail('adult')) }, { person: grownUp(dup) }]
  const r = await call('register-team', await teamBody(event, members), session)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.deepEqual(r.body, { error: DUPLICATE, code: 'duplicate', index: 2, errors: { 2: { email: DUPLICATE } } })
  assert.equal((await teamsOf(event.eventId)).length, 1)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)

  for (let i = 0; i < 4; i++) await call('register-team', await teamBody(event, members), session)
  const capped = await call('register-team', await teamBody(event, members), session)
  assert.equal(capped.status, 409)
  assert.equal(capped.body.code, 'refused')
  assert.equal(capped.body.errors, undefined)
})

test('T-44 full → „Brak wolnych miejsc dla drużyn.”, free and paid', async () => {
  const free = await freeTeamEvent(owner, { capacity: 1 })
  const a = runnerEmail('capt')
  assert.equal((await call('register-team', await teamBody(free, fourOf(a, runnerEmail('adult'))), await sessionFor(a))).status, 201)
  const b = runnerEmail('capt')
  const r = await call('register-team', await teamBody(free, fourOf(b, runnerEmail('adult'))), await sessionFor(b))
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.deepEqual(r.body, { error: NO_PLACES, code: 'full' })

  const paid = await paidTeamEvent(owner, { capacity: 1 })
  const one1 = await pendingTeam({ event: paid })
  await payMock(one1.txn.id, 'paid')
  await waitFor(async () => (await orderOf(one1.orderId)).status === 'paid', 'payment')
  const c = runnerEmail('capt')
  const p = await call('register-team', await teamBody(paid, fourOf(c, runnerEmail('adult'))), await sessionFor(c))
  assert.equal(p.status, 409, JSON.stringify(p.body))
  assert.deepEqual(p.body, { error: NO_PLACES, code: 'full' })
})

test('T-44 consents, price and window: consents_changed, price_changed with the amounts, too_many_pending, closed and not_open, paying_closed', async () => {
  const event = await paidTeamEvent(owner)
  const me = runnerEmail('capt')
  const session = await sessionFor(me)

  const noConsents = await call('register-team', await teamBody(event, fourOf(me, runnerEmail('adult')), { acceptedConsentIds: [] }), session)
  assert.equal(noConsents.status, 400)
  assert.equal(noConsents.body.error, 'Zaznacz wymagane zgody.')

  const changed = await call('register-team', await teamBody(event, fourOf(me, runnerEmail('adult')), { displayedTotal: 23999 }), session)
  assert.equal(changed.status, 409, JSON.stringify(changed.body))
  assert.equal(changed.body.code, 'price_changed')
  assert.deepEqual(changed.body.amounts, { entryPrices: [24000], entryTotal: 24000, extrasTotal: 0, donation: 0, total: 24000 })

  const bad = await call('register-team', await teamBody(event, fourOf(me, runnerEmail('adult')), { displayedTotal: -1 }), session)
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'invalid_total')

  // Two pending orders of this account, none of them this squad.
  const buyer = runnerEmail('buyer')
  const two = await paidTeamEvent(owner, { competitions: [STAFETA(), BIEG()], prices: { Sztafeta: 24000, 'Bieg 9 km': 6000 } })
  await orderOk(two, { categoryId: two.categoryIds[1], emails: [runnerEmail('r')], buyerEmail: buyer })
  await orderOk(two, { categoryId: two.categoryIds[1], emails: [runnerEmail('r')], buyerEmail: buyer })
  const tooMany = await call('register-team', await teamBody(two, fourOf(buyer, runnerEmail('adult'))), await sessionFor(buyer))
  assert.equal(tooMany.status, 409, JSON.stringify(tooMany.body))
  assert.equal(tooMany.body.code, 'too_many_pending')
  assert.equal(tooMany.body.error, 'Masz już dwa nieopłacone zgłoszenia na te zawody.')

  const closing = await paidTeamEvent(owner)
  await db().from('registration_settings').update({ closes_at: new Date(Date.now() + 30 * 60_000).toISOString() }).eq('event_id', closing.eventId)
  const late = await call('register-team', await teamBody(closing, fourOf(me, runnerEmail('adult'))), session)
  assert.equal(late.status, 409, JSON.stringify(late.body))
  assert.equal(late.body.code, 'paying_closed')

  const closed = await paidTeamEvent(owner)
  await db().from('registration_settings').update({ closes_at: new Date(Date.now() - 1000).toISOString() }).eq('event_id', closed.eventId)
  const shut = await call('register-team', await teamBody(closed, fourOf(me, runnerEmail('adult'))), session)
  assert.equal(shut.status, 409)
  assert.deepEqual(shut.body, { error: 'Zapisy są zamknięte.', code: 'closed' })

  const soon = await paidTeamEvent(owner)
  await db().from('registration_settings').update({ opens_at: new Date(Date.now() + 3600_000).toISOString() }).eq('event_id', soon.eventId)
  const early = await call('register-team', await teamBody(soon, fourOf(me, runnerEmail('adult'))), session)
  assert.equal(early.status, 409)
  assert.deepEqual(early.body, { error: 'Zapisy jeszcze się nie rozpoczęły.', code: 'not_open' })
  assert.equal((await byEvent(event.eventId)).length, 0)
})

// ---------------------------------------------------------------- T-45 the request

test('T-45 who registers: no session and no code → 401; the e-mail code logs the captain in and sets the cookie; the honeypot writes nothing; the captain must be the address that logs in', async () => {
  const event = await freeTeamEvent(owner)
  const me = runnerEmail('capt')
  const members = fourOf(me, runnerEmail('adult'))
  const r = await call('register-team', await teamBody(event, members))
  assert.equal(r.status, 401, JSON.stringify(r.body))
  assert.equal(r.body.code, 'code_required')
  assert.equal((await byEvent(event.eventId)).length, 0)

  const asOther = await call('register-team', await teamBody(event, members), await sessionFor(runnerEmail('other')))
  assert.equal(asOther.status, 401, JSON.stringify(asOther.body))

  const bot = await call('register-team', await teamBody(event, members, { website: 'https://spam.example' }), await sessionFor(me))
  assert.equal(bot.status, 200, JSON.stringify(bot.body))
  assert.equal(bot.body.data, undefined)
  assert.equal((await byEvent(event.eventId)).length, 0)

  const res = await fetch(`${localEnv().functionsUrl}/auth-request-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: me }),
  })
  assert.equal(res.status, 200)
  let code = null
  for (let i = 0; i < 20 && !code; i++) { code = await lastCodeFor(me); if (!code) await sleep(250) }
  const signed = await call('register-team', await teamBody(event, members, { code }))
  assert.equal(signed.status, 201, JSON.stringify(signed.body))
  assert.match(signed.setCookie ?? '', /HttpOnly/i)
})

test('T-45 validateTeam answers: name and consent under fields, a minor captain, a member\'s field under errors, the squad size, an individual competition', async () => {
  const event = await freeTeamEvent(owner)
  const me = runnerEmail('capt')
  const session = await sessionFor(me)
  const members = fourOf(me, runnerEmail('adult'))

  const name = await call('register-team', await teamBody(event, members, { teamName: 'x', membersConsent: false }), session)
  assert.equal(name.status, 400)
  assert.equal(name.body.code, 'invalid_person')
  assert.deepEqual(name.body.fields, { teamName: TEAM_NAME_MESSAGE, membersConsent: MEMBERS_CONSENT_MESSAGE })

  const minor = await call('register-team', await teamBody(event, [
    { person: grownUp(me, { birthDate: '2015-01-01' }), guardianConsent: true }, members[1],
  ]), session)
  assert.equal(minor.status, 400)
  assert.equal(minor.body.code, 'invalid_group')
  assert.equal(minor.body.error, CAPTAIN_MESSAGE)

  const noConsent = await call('register-team', await teamBody(event, [members[0], members[1], { person: child() }]), session)
  assert.equal(noConsent.status, 400)
  assert.equal(noConsent.body.code, 'invalid_person')
  assert.deepEqual(noConsent.body.errors, { 2: { guardianConsent: 'Zaznacz zgodę opiekuna.' } })

  const alone = await call('register-team', await teamBody(event, [members[0]]), session)
  assert.equal(alone.status, 400)
  assert.equal(alone.body.code, 'invalid_group')
  assert.equal(alone.body.error, teamSizeMessage(2, 6))

  const solo = await freeTeamEvent(owner, { competitions: [BIEG()] })
  const notTeam = await call('register-team', await teamBody(solo, members), session)
  assert.equal(notTeam.status, 409, JSON.stringify(notTeam.body))
  assert.equal(notTeam.body.code, 'not_team')

  const unknown = await call('register-team', await teamBody(event, members, { categoryId: crypto.randomUUID() }), session)
  assert.equal(unknown.status, 404)
  assert.equal((await byEvent(event.eventId)).length, 0)
})

test('T-45 leg order: legs are stored when on, refused when not 1…n; a retired member → 403 with their index, only to a verified captain', async () => {
  const event = await freeTeamEvent(owner, { legOrder: true })
  const me = runnerEmail('capt')
  const session = await sessionFor(me)
  const partner = runnerEmail('adult')
  const noLegs = await call('register-team', await teamBody(event, [{ person: grownUp(me) }, { person: grownUp(partner) }]), session)
  assert.equal(noLegs.status, 400)
  assert.equal(noLegs.body.error, 'Ustal kolejność zmian.')
  const ok = await call('register-team', await teamBody(event, [{ person: grownUp(me), leg: 2 }, { person: grownUp(partner), leg: 1 }]), session)
  assert.equal(ok.status, 201, JSON.stringify(ok.body))
  const regs = await byEvent(event.eventId)
  assert.equal(regs.find((x) => x.email === me).team_leg, 2)
  assert.equal(regs.find((x) => x.email === partner).team_leg, 1)

  const other = await freeTeamEvent(owner)
  await setLegOrder(other.categoryIds[0], false)
  const gone = runnerEmail('gone')
  const hash = crypto.createHash('sha256').update(gone).digest('hex')
  assert.ifError((await db().from('deleted_email_hashes').upsert({ email_hash: hash }, { onConflict: 'email_hash' })).error)
  const members = [{ person: grownUp(me) }, { person: grownUp(gone) }]
  const anon = await call('register-team', await teamBody(other, members))
  assert.equal(anon.status, 401)
  const r = await call('register-team', await teamBody(other, members), session)
  assert.equal(r.status, 403, JSON.stringify(r.body))
  assert.deepEqual(r.body, { error: RETIRED_EMAIL_MESSAGE, code: 'email_retired', index: 1 })
  assert.equal((await byEvent(other.eventId)).length, 0)
})

test('T-45 D5-24 a captain\'s resubmit while their team waits for payment → 409 pending_order with its id, under the same name and under another; nothing new is written', async () => {
  const { event, me, partner, session, body, orderId } = await pendingTeam()
  const same = await call('register-team', body, session)
  assert.equal(same.status, 409, JSON.stringify(same.body))
  assert.deepEqual(same.body, { error: PENDING_ORDER, code: 'pending_order', orderId })

  const renamed = await call('register-team', await teamBody(event, fourOf(me, partner)), session)
  assert.equal(renamed.status, 409, JSON.stringify(renamed.body))
  assert.deepEqual(renamed.body, { error: PENDING_ORDER, code: 'pending_order', orderId })
  assert.equal((await rows('orders', { event_id: event.eventId })).length, 1)
  assert.equal((await teamsOf(event.eventId)).length, 1)
})

test('T-45 D5-24 dpay refuses the registration → 502 naming the order, which stays pending and keeps the name; pay-order pays it', async () => {
  const event = await paidTeamEvent(owner)
  const me = runnerEmail('capt')
  const session = await sessionFor(me)
  const body = await teamBody(event, fourOf(me, runnerEmail('adult')))
  await dpayMode({ registerFails: true })
  const r = await call('register-team', body, session)
  assert.equal(r.status, 502, JSON.stringify(r.body))
  const [order] = await rows('orders', { event_id: event.eventId })
  assert.deepEqual(r.body, { error: DPAY_DOWN, code: 'dpay_unavailable', orderId: order.id })
  assert.equal(order.status, 'pending')
  assert.equal(order.cancelled_reason, null)
  assert.equal((await teamsOf(event.eventId))[0].released_at, null, 'the name stays with the pending team')
  const logged = await rows('payment_events', { order_id: order.id })
  assert.equal(logged.filter((e) => e.kind === 'register' && e.payload.ok === false).length, 1)

  await dpayReset()
  const again = await call('register-team', body, session)
  assert.equal(again.status, 409, JSON.stringify(again.body))
  assert.equal(again.body.orderId, order.id)
  const paid = await call('pay-order', { orderId: order.id }, session)
  assert.equal(paid.status, 200, JSON.stringify(paid.body))
  assert.ok(paid.body.data.redirectUrl)
})

test('T-45 D5-24 pay-order on a team order: a new transaction at the frozen fee; a dpay failure leaves the order pending', async () => {
  const { orderId, session } = await pendingTeam()
  await dpayMode({ registerFails: true })
  const down = await call('pay-order', { orderId }, session)
  assert.equal(down.status, 502, JSON.stringify(down.body))
  assert.deepEqual(down.body, { error: DPAY_DOWN, code: 'dpay_unavailable' })
  const order = await orderOf(orderId)
  assert.equal(order.status, 'pending')
  assert.equal(order.cancelled_reason, null)

  await dpayMode({ registerFails: false })
  const r = await call('pay-order', { orderId }, session)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(r.body.data.redirectUrl)
  assert.equal((await rows('payment_attempts', { order_id: orderId })).length, 2)
  assert.equal((await dpayTransactions()).at(-1).grosze, 24000)
})

// ---------------------------------------------------------------- Task 5b helpers

const SQUAD_CLOSED = 'Zapisy są zamknięte — skład zmienisz w biurze zawodów.'
const REMOVED_SUBJECT = (name) => `Nie jesteś już w składzie drużyny ${name}`
const CHANGED_SUBJECT = (name, event) => `Zmiana składu drużyny ${name} — ${event}`
const TOKEN_RE = /\/zgoda#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/

const squadCall = (teamId, action, session, over = {}) => call('team-squad', { teamId, action, ...over }, session)
const swapIn = (email, over = {}) => grownUp(email, { firstName: 'Anna', lastName: 'Nowa', ...over })

/** A confirmed free team through register-team; the mail from signing up is waited for and cleared by the tests' own counts. */
async function freeTeam(opts = {}) {
  const event = opts.event ?? await freeTeamEvent(owner, opts.eventOpts)
  const me = runnerEmail('capt')
  const partner = runnerEmail('adult')
  const session = await sessionFor(me)
  const body = await teamBody(event, opts.members?.(me, partner) ?? fourOf(me, partner))
  const r = await call('register-team', body, session)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  await waitForMail(partner)
  return { event, me, partner, session, body, teamId: r.body.data.teamId }
}

/** A paid team, paid in full. */
async function paidTeam(opts = {}) {
  const t = await pendingTeam(opts)
  await payMock(t.txn.id, 'paid')
  await waitFor(async () => (await orderOf(t.orderId)).status === 'paid', 'the payment')
  await waitForMail(t.partner)
  return t
}

const live = (regs) => regs.filter((r) => ['confirmed', 'pending_payment'].includes(r.status))
const walk = (v, path = '') => (v && typeof v === 'object'
  ? Object.entries(v).flatMap(([k, x]) => [`${path}.${k}`, ...walk(x, `${path}.${k}`)])
  : [])

// ---------------------------------------------------------------- T-42 get

test('T-42 get: no session 401; a stranger, a team member, a bad id and an unknown team → 404; the club owner reads it (Plan 6)', async () => {
  const { teamId, partner } = await freeTeam()
  assert.equal((await squadCall(teamId, 'get', null)).status, 401)
  // Plan 6, ruling 11: the club's owner and admins may read and edit a squad (organizer-edge O-36).
  assert.equal((await squadCall(teamId, 'get', owner)).status, 200)
  for (const session of [await sessionFor(runnerEmail('stranger')), await sessionFor(partner)]) {
    const r = await squadCall(teamId, 'get', session)
    assert.equal(r.status, 404, JSON.stringify(r.body))
    assert.deepEqual(r.body, { error: 'Not found' })
  }
  const me = await sessionFor(runnerEmail('capt'))
  assert.equal((await squadCall('nie-uuid', 'get', me)).status, 404)
  assert.equal((await squadCall(crypto.randomUUID(), 'get', me)).status, 404)
})

test('T-42 get: the captain sees the team, its limits and the live squad, and no address, phone or birth date anywhere', async () => {
  const { event, session, teamId, body, partner } = await freeTeam({ eventOpts: { legOrder: false } })
  const r = await squadCall(teamId, 'get', session)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const { team, members, competition, event: ev } = r.body.data
  assert.deepEqual({ ...team, closesAt: undefined }, {
    name: body.teamName, status: 'confirmed', paymentStatus: 'free', orderId: null, closesAt: undefined,
    legOrderEnabled: false, teamMin: 2, teamMax: 6, editsOpen: true, payable: false,
  })
  const settings = await one('registration_settings', { event_id: event.eventId })
  assert.equal(Date.parse(team.closesAt), Date.parse(settings.closes_at))
  assert.equal(competition.name, 'Sztafeta')
  assert.equal(ev.slug, settings.slug)
  assert.equal(ev.name, settings.name)

  assert.equal(members.length, 4)
  const [captain, ...rest] = members
  assert.equal(captain.isCaptain, true)
  assert.equal(captain.role, 'self')
  assert.equal(captain.consentState, 'accepted')
  assert.equal(captain.age, new Date(settings.event_date).getUTCFullYear() - 1990 - (settings.event_date.slice(5) < '05-01' ? 1 : 0))
  assert.deepEqual(rest.map((m) => m.isCaptain), [false, false, false])
  assert.deepEqual(rest.map((m) => m.role).sort(), ['adult', 'minor', 'minor'])
  // M-2: with leg order off, the order the captain gave (team_position), never a random id.
  assert.deepEqual(members.map((m) => m.firstName), body.members.map((m) => m.person.firstName))
  const adult = rest.find((m) => m.role === 'adult')
  assert.equal(adult.consentState, 'awaiting')
  assert.deepEqual(Object.keys(adult).sort(), ['age', 'ageGroupLabel', 'consentState', 'firstName', 'isCaptain', 'lastName', 'leg', 'registrationId', 'role'])
  assert.equal(adult.leg, null)

  const keys = walk(r.body).join(' ')
  assert.doesNotMatch(keys, /email|phone|birth|ice|guardian/i)
  assert.ok(!JSON.stringify(r.body).includes(partner))
})

test('T-42 get: a pending team carries its order and reads as awaiting; a released team answers 404 to a read and team_inactive to an edit', async () => {
  const { teamId, orderId, session } = await pendingTeam()
  const r = await squadCall(teamId, 'get', session)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.team.status, 'pending_payment')
  assert.equal(r.body.data.team.paymentStatus, 'awaiting')
  assert.equal(r.body.data.team.orderId, orderId)

  const cancelled = await call('cancel-my-order', { orderId }, session)
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
  const gone = await squadCall(teamId, 'get', session)
  assert.equal(gone.status, 404, JSON.stringify(gone.body))
  assert.deepEqual(gone.body, { error: 'Not found' })
  const edit = await squadCall(teamId, 'add', session, { person: swapIn(runnerEmail('late')) })
  assert.equal(edit.status, 409, JSON.stringify(edit.body))
  assert.deepEqual(edit.body, { error: 'To zgłoszenie nie jest już aktywne.', code: 'team_inactive' })
})

test('T-42 a disabled club: 404 to the captain, for a read and an edit', async () => {
  const slug = `squad-${crypto.randomBytes(4).toString('hex')}`
  const club = await makeClub({ slug })
  const { teamId, session } = await freeTeam({ event: await freeTeamEvent(await sessionFor(club.ownerEmail), { clubSlug: slug }) })
  assert.equal((await squadCall(teamId, 'get', session)).status, 200)
  await makeClub({ slug, enabled: false })
  assert.equal((await squadCall(teamId, 'get', session)).status, 404)
  assert.equal((await squadCall(teamId, 'add', session, { person: swapIn(runnerEmail('x')) })).status, 404)
})

test('T-42 the throttle: squad:<teamId> allows 30 edits an hour, a stranger spends none, and a read spends none of them', async () => {
  const { teamId, session } = await freeTeam()
  const stranger = await sessionFor(runnerEmail('stranger'))
  for (let i = 0; i < 5; i++) assert.equal((await squadCall(teamId, 'remove', stranger)).status, 404)
  for (let i = 0; i < 40; i++) assert.equal((await squadCall(teamId, 'get', session)).status, 200, `read ${i + 1}`)
  // 7b review: an unknown action is refused before the allowance, so it spends none of it.
  for (let i = 0; i < 40; i++) assert.equal((await squadCall(teamId, 'remove', session)).status, 422, `unknown ${i + 1}`)
  for (let i = 0; i < 30; i++) {
    const ok = await squadCall(teamId, 'reorder', session, { legs: [] })
    assert.equal(ok.status, 409, `edit ${i + 1}: ${JSON.stringify(ok.body)}`)
  }
  const r = await squadCall(teamId, 'reorder', session, { legs: [] })
  assert.equal(r.status, 429, JSON.stringify(r.body))
  assert.equal(r.body.error, 'Zbyt wiele prób. Spróbuj ponownie później.')
  assert.equal((await squadCall(teamId, 'get', session)).status, 200, 'an edit limit reached leaves the page readable')
})

test('T-42 the read limit: 120 reads an hour, then 429, and edits keep their own allowance', async () => {
  const { teamId, session } = await freeTeam()
  for (let i = 0; i < 120; i++) assert.equal((await squadCall(teamId, 'get', session)).status, 200, `read ${i + 1}`)
  assert.equal((await squadCall(teamId, 'get', session)).status, 429)
  assert.equal((await squadCall(teamId, 'remove', session)).status, 422)
})

test('T-77 team.payable: a pending order that can still be paid; not once the competition is full, nor past close', async () => {
  const { event, session, teamId } = await pendingTeam()
  const payable = async () => (await squadCall(teamId, 'get', session)).body.data.team.payable
  assert.equal(await payable(), true)
  const cat = event.categoryIds[0]
  const { capacity } = await competitionOf(cat)
  const set = async (table, key, id, values) => {
    const { error } = await db().from(table).update(values).eq(key, id)
    assert.equal(error, null, error?.message)
  }
  await set('competitions', 'category_id', cat, { taken: capacity })
  assert.equal(await payable(), false, 'P3-R15: paid entries filled the competition')
  await set('competitions', 'category_id', cat, { taken: 0 })
  assert.equal(await payable(), true)
  await set('registration_settings', 'event_id', event.eventId, { closes_at: new Date(Date.now() - 60_000).toISOString() })
  assert.equal(await payable(), false)
})

// ---------------------------------------------------------------- T-42 swap

test('T-47 the captain swaps in an adult with name, birth date, gender and e-mail only: the rest is theirs to give on /zgoda', async () => {
  const { event, partner, session, teamId } = await freeTeam()
  await waitForMail(partner)
  const old = (await byEvent(event.eventId)).find((r) => r.email === partner)
  const next = runnerEmail('five')
  const { phone: _phone, ...five } = swapIn(next)
  const r = await squadCall(teamId, 'swap', session, { registrationId: old.id, person: five })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.asOrganizer, false)
  const added = (await byEvent(event.eventId)).find((x) => x.email === next)
  assert.equal(added.status, 'confirmed')
  assert.equal(added.phone, null)
  const [asked] = await waitForMail(next)
  assert.ok(asked.text.includes('uzupełnisz'))
})

test('T-42 a swap on a confirmed team: the adult out gets „Nie jesteś już w składzie”, the adult in a consent e-mail, the captain a summary; the old link is gone', async () => {
  const { event, me, partner, session, teamId, body } = await freeTeam()
  const [askedOld] = await waitForMail(partner)
  const oldToken = TOKEN_RE.exec(askedOld.text)[1]
  const before = await byEvent(event.eventId)
  const old = before.find((r) => r.email === partner)
  const next = runnerEmail('next')

  const r = await squadCall(teamId, 'swap', session, { registrationId: old.id, person: swapIn(next) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.members.length, 4)
  assert.ok(r.body.data.members.some((m) => m.firstName === 'Anna' && m.consentState === 'awaiting'))
  assert.ok(!r.body.data.members.some((m) => m.registrationId === old.id))

  const name = await eventName(event.eventId)
  const out = await waitForMail(partner, 2)
  assert.deepEqual(out.map((m) => m.subject).sort(), [askedOld.subject, REMOVED_SUBJECT(body.teamName)].sort())
  assert.ok(out.find((m) => m.subject === REMOVED_SUBJECT(body.teamName)).text.includes('Piotr'))

  const asked = await waitForMail(next)
  assert.equal(asked.length, 1)
  assert.match(asked[0].subject, CONSENT_SUBJECT)
  assert.ok(asked[0].text.includes(`w drużynie ${body.teamName}`))
  assert.ok(asked[0].text.includes('Ola Leśna zapisał(a) Cię'))

  const mine = (await waitForMail(me, 2)).filter((m) => m.subject === CHANGED_SUBJECT(body.teamName, name))
  assert.equal(mine.length, 1)
  for (const part of ['Piotr', 'Anna Nowa', 'Zarządzaj składem']) assert.ok(mine[0].text.includes(part), part)
  assert.match(mine[0].text, new RegExp(`/druzyna/${teamId}\\b`))
  assert.ok(!mine[0].text.includes(next), 'no address in the captain summary')

  const after = await byEvent(event.eventId)
  assert.equal(after.find((x) => x.id === old.id).status, 'cancelled')
  assert.equal(live(after).length, 4)
  const added = after.find((x) => x.email === next)
  assert.equal(added.status, 'confirmed')
  assert.equal(added.registered_by_profile_id, before.find((x) => x.email === me).profile_id)
  const { removed_at: removedAt } = await one('participants', { id: old.participant_id })
  assert.ok(removedAt, 'the participant left the start list')
  assert.ok(added.participant_id)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)
  await assertSlotInvariant(event.categoryIds[0])

  const dead = await call('consent-request', { token: oldToken })
  assert.equal(dead.status, 409, JSON.stringify(dead.body))
  assert.deepEqual(dead.body, { error: 'To zgłoszenie nie jest już aktywne.', code: 'gone' })
})

test('T-42 a swap of a child tells only the captain; the child in needs the guardian consent and the event consents', async () => {
  const { event, me, session, teamId, body, partner } = await freeTeam()
  const regs = await byEvent(event.eventId)
  const out = regs.find((r) => r.first_name === 'Staś')
  const newChild = child({ firstName: 'Janek', lastName: `Nowy${crypto.randomBytes(3).toString('hex')}`, gender: 'M' })

  const noConsent = await squadCall(teamId, 'swap', session, {
    registrationId: out.id, person: newChild, acceptedConsentIds: body.acceptedConsentIds, serviceRegulamin: true,
  })
  assert.equal(noConsent.status, 400, JSON.stringify(noConsent.body))
  assert.equal(noConsent.body.fields.guardianConsent, 'Zaznacz zgodę opiekuna.')

  const noIds = await squadCall(teamId, 'swap', session, {
    registrationId: out.id, person: newChild, guardianConsent: true, acceptedConsentIds: [], serviceRegulamin: true,
  })
  assert.equal(noIds.status, 400, JSON.stringify(noIds.body))
  assert.deepEqual(noIds.body, { error: 'Zaznacz wymagane zgody.', code: 'consents_changed' })
  const noService = await squadCall(teamId, 'swap', session, {
    registrationId: out.id, person: newChild, guardianConsent: true, acceptedConsentIds: body.acceptedConsentIds,
  })
  assert.equal(noService.status, 400, JSON.stringify(noService.body))
  assert.equal(noService.body.code, 'consents_required')
  assert.equal((await byEvent(event.eventId)).find((r) => r.id === out.id).status, 'confirmed', 'a refused swap cancels nobody')

  const ok = await squadCall(teamId, 'swap', session, {
    registrationId: out.id, person: newChild, guardianConsent: true,
    acceptedConsentIds: body.acceptedConsentIds, serviceRegulamin: true,
  })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  const added = (await byEvent(event.eventId)).find((r) => r.first_name === 'Janek')
  assert.equal(added.email, null)
  assert.equal(added.consent_state, 'accepted')
  assert.ok(added.guardian_profile_id)
  const acceptances = await rows('consent_acceptances', { registration_id: added.id })
  assert.equal(acceptances.length, body.acceptedConsentIds.length + 1)
  assert.ok(acceptances.every((a) => a.accepted_as === 'guardian'))

  const name = await eventName(event.eventId)
  const summary = (await waitForMail(me, 2)).filter((m) => m.subject === CHANGED_SUBJECT(body.teamName, name))
  assert.equal(summary.length, 1)
  assert.ok(summary[0].text.includes('Staś'))
  assert.ok(summary[0].text.includes('Janek'))
  await sleep(300)
  assert.equal((await messagesTo(partner)).length, 1, 'the other adult hears nothing')
})

test('T-42 a swap on a pending team: nobody but the captain is told; the adult in is asked when the fee lands, once', async () => {
  const { event, me, partner, session, teamId, txn, orderId, body } = await pendingTeam()
  const old = (await byEvent(event.eventId)).find((r) => r.email === partner)
  const next = runnerEmail('next')
  const r = await squadCall(teamId, 'swap', session, { registrationId: old.id, person: swapIn(next) })
  assert.equal(r.status, 200, JSON.stringify(r.body))

  const name = await eventName(event.eventId)
  assert.equal((await waitForMail(me)).filter((m) => m.subject === CHANGED_SUBJECT(body.teamName, name)).length, 1)
  await sleep(400)
  assert.deepEqual(await messagesTo(partner), [], 'an adult who was never told gets no „removed” e-mail')
  assert.deepEqual(await messagesTo(next), [], 'no consent e-mail while the fee is unpaid')
  const added = (await byEvent(event.eventId)).find((x) => x.email === next)
  assert.equal(added.status, 'pending_payment')
  assert.equal(added.order_id, orderId)

  await payMock(txn.id, 'paid')
  await waitFor(async () => (await messagesTo(next)).length === 1, 'the consent e-mail')
  await replayIpn(txn.id)
  await sleep(300)
  assert.equal((await messagesTo(next)).length, 1)
  assert.deepEqual(await messagesTo(partner), [])
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)
  await assertSlotInvariant(event.categoryIds[0])
})

test('T-42 a swap keeping the same address sends no „removed” e-mail, only a new consent request', async () => {
  const { event, partner, session, teamId, body } = await freeTeam()
  const old = (await byEvent(event.eventId)).find((r) => r.email === partner)
  const r = await squadCall(teamId, 'swap', session, { registrationId: old.id, person: swapIn(partner, { firstName: 'Piotrek' }) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const mails = await waitForMail(partner, 2)
  assert.equal(mails.length, 2)
  assert.ok(!mails.some((m) => m.subject === REMOVED_SUBJECT(body.teamName)))
})

test('T-42 a swap keeping the address in another case sends no „removed” e-mail', async () => {
  const { event, partner, session, teamId, body } = await freeTeam()
  const old = (await byEvent(event.eventId)).find((r) => r.email === partner)
  const { error } = await db().from('registrations').update({ email: partner.toUpperCase() }).eq('id', old.id)
  if (error) throw error
  const r = await squadCall(teamId, 'swap', session, { registrationId: old.id, person: swapIn(partner, { firstName: 'Piotrek' }) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  await waitForMail(partner, 2)
  const mails = [...await messagesTo(partner), ...await messagesTo(partner.toUpperCase())]
  assert.ok(!mails.some((m) => m.subject === REMOVED_SUBJECT(body.teamName)))
})

test('T-42 refusals of a swap: the captain, a stranger\'s row, a duplicate; nothing changes and the second address hears nothing', async () => {
  const { event, me, partner, session, teamId } = await freeTeam()
  const regs = await byEvent(event.eventId)
  const captainRow = regs.find((r) => r.email === me)
  const person = swapIn(runnerEmail('next'))

  const fixed = await squadCall(teamId, 'swap', session, { registrationId: captainRow.id, person })
  assert.equal(fixed.status, 409, JSON.stringify(fixed.body))
  assert.deepEqual(fixed.body, { error: 'Kapitana nie można wymienić.', code: 'captain_fixed' })

  const stranger = await squadCall(teamId, 'swap', session, { registrationId: crypto.randomUUID(), person })
  assert.equal(stranger.status, 409, JSON.stringify(stranger.body))
  assert.deepEqual(stranger.body, { error: 'Tej osoby nie ma już w składzie. Odśwież stronę.', code: 'not_member' })

  const old = regs.find((r) => r.email === partner)
  const dup = await squadCall(teamId, 'swap', session, { registrationId: old.id, person: swapIn(me) })
  assert.equal(dup.status, 409, JSON.stringify(dup.body))
  assert.equal(dup.body.code, 'duplicate')
  assert.equal(dup.body.fields.email, 'Ten adres e-mail jest już zapisany na te zawody.')
  const after = await byEvent(event.eventId)
  assert.equal(after.find((r) => r.id === old.id).status, 'confirmed')
  assert.equal(live(after).length, 4)
})

test('T-42 a duplicate past the daily reveal cap names nobody', async () => {
  const { event, me, partner, session, teamId } = await freeTeam()
  const { error } = await db().rpc('claim_throttle_slot', { p_key: `register-duplicate:${me}`, p_limit: 5, p_window_seconds: 86400 })
  if (error) throw error
  for (let i = 0; i < 4; i++) await db().rpc('claim_throttle_slot', { p_key: `register-duplicate:${me}`, p_limit: 5, p_window_seconds: 86400 })
  const old = (await byEvent(event.eventId)).find((r) => r.email === partner)
  const r = await squadCall(teamId, 'swap', session, { registrationId: old.id, person: swapIn(me) })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'refused')
  assert.equal(r.body.fields, undefined)
})

test('T-42 age against role is decided here, never by the client; a bad date is a field error, not a 500', async () => {
  const { event, session, teamId } = await freeTeam()
  const lied = await squadCall(teamId, 'add', session, {
    person: { ...child({ firstName: 'Jurek', email: runnerEmail('kid') }), role: 'adult' },
  })
  assert.equal(lied.status, 400, JSON.stringify(lied.body))
  assert.equal(lied.body.fields.guardianConsent, 'Zaznacz zgodę opiekuna.')

  for (const birthDate of ['2016-02-31', 'jutro', '', null, '20160505']) {
    const bad = await squadCall(teamId, 'add', session, { person: swapIn(runnerEmail('bad'), { birthDate }) })
    assert.equal(bad.status, 400, `${birthDate}: ${JSON.stringify(bad.body)}`)
    assert.equal(bad.body.code, 'invalid_person')
    assert.equal(bad.body.fields.birthDate, 'Podaj poprawną datę urodzenia.')
  }
  const missing = await squadCall(teamId, 'add', session, {})
  assert.equal(missing.status, 400, JSON.stringify(missing.body))
  assert.equal(missing.body.code, 'invalid_person')

  const claimedMinor = await squadCall(teamId, 'add', session, { person: { ...swapIn(runnerEmail('grown')), role: 'minor' } })
  assert.equal(claimedMinor.status, 200, JSON.stringify(claimedMinor.body))
  const stored = (await byEvent(event.eventId)).find((r) => r.first_name === 'Anna')
  assert.equal(stored.guardian_profile_id, null, 'a claimed role never makes a grown-up a child')
  assert.equal(stored.consent_state, 'awaiting')
})

test('T-42 a retired address is refused for the verified captain, with nothing written', async () => {
  const { event, session, teamId } = await freeTeam()
  const email = runnerEmail('gone')
  const hash = crypto.createHash('sha256').update(email).digest('hex')
  const { error } = await db().from('deleted_email_hashes').upsert({ email_hash: hash }, { onConflict: 'email_hash' })
  if (error) throw error
  const r = await squadCall(teamId, 'add', session, { person: swapIn(email) })
  assert.equal(r.status, 403, JSON.stringify(r.body))
  assert.deepEqual(r.body, { error: RETIRED_EMAIL_MESSAGE, code: 'email_retired' })
  assert.equal(live(await byEvent(event.eventId)).length, 4)
})

test('T-42 the buyer\'s daily people cap counts squad changes: mail to third parties is not free', async () => {
  const { event, me, session, teamId } = await freeTeam()
  for (let i = 0; i < 30; i++) {
    await db().rpc('claim_throttle_slot', { p_key: `register-people:${me}`, p_limit: 30, p_window_seconds: 86400 })
  }
  const next = runnerEmail('next')
  const r = await squadCall(teamId, 'add', session, { person: swapIn(next) })
  assert.equal(r.status, 429, JSON.stringify(r.body))
  assert.equal(live(await byEvent(event.eventId)).length, 4)
  assert.deepEqual(await messagesTo(next), [])
})

// ---------------------------------------------------------------- T-42 add, reorder, close

test('T-42 add: an adult up to team_max gets a consent e-mail, then „Skład jest pełny.”', async () => {
  const { event, me, session, teamId, body } = await freeTeam()
  const third = runnerEmail('third')
  const r = await squadCall(teamId, 'add', session, { person: swapIn(third) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.members.length, 5)
  assert.equal((await waitForMail(third)).length, 1)
  const name = await eventName(event.eventId)
  assert.equal((await waitForMail(me, 2)).filter((m) => m.subject === CHANGED_SUBJECT(body.teamName, name)).length, 1)

  assert.equal((await squadCall(teamId, 'add', session, { person: swapIn(runnerEmail('sixth')) })).status, 200)
  const full = await squadCall(teamId, 'add', session, { person: swapIn(runnerEmail('seventh')) })
  assert.equal(full.status, 409, JSON.stringify(full.body))
  assert.deepEqual(full.body, { error: 'Skład jest pełny.', code: 'team_full' })
  assert.equal(live(await byEvent(event.eventId)).length, 6)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)
  await assertSlotInvariant(event.categoryIds[0])
})

test('T-42 add a child: the guardian consent and the event consents are required; the captain is the guardian, no e-mail but the summary', async () => {
  const { event, me, session, teamId, body } = await freeTeam()
  const kid = child({ firstName: 'Lena', lastName: `Nowa${crypto.randomBytes(3).toString('hex')}` })
  const refused = await squadCall(teamId, 'add', session, { person: kid, guardianConsent: true, serviceRegulamin: true })
  assert.equal(refused.status, 400, JSON.stringify(refused.body))
  assert.equal(refused.body.code, 'consents_changed')

  const r = await squadCall(teamId, 'add', session, {
    person: kid, guardianConsent: true, acceptedConsentIds: body.acceptedConsentIds, serviceRegulamin: true,
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const stored = (await byEvent(event.eventId)).find((x) => x.first_name === 'Lena')
  assert.equal(stored.guardian_name, 'Ola Leśna')
  assert.ok(r.body.data.members.some((m) => m.firstName === 'Lena' && m.role === 'minor' && m.consentState === 'accepted'))
  const name = await eventName(event.eventId)
  assert.equal((await waitForMail(me, 2)).filter((m) => m.subject === CHANGED_SUBJECT(body.teamName, name)).length, 1)
})

test('T-42 reorder: the legs move and nobody gets an e-mail; a stale list and a competition without leg order are refused', async () => {
  const legs = (me, partner) => fourOf(me, partner).map((m, i) => ({ ...m, leg: i + 1 }))
  const { event, me, partner, session, teamId } = await freeTeam({ eventOpts: { legOrder: true }, members: legs })
  const got = await squadCall(teamId, 'get', session)
  assert.deepEqual(got.body.data.members.map((m) => m.leg), [1, 2, 3, 4])
  const ids = got.body.data.members.map((m) => m.registrationId)

  const reversed = [...ids].reverse()
  const r = await squadCall(teamId, 'reorder', session, { legs: reversed })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.data.members.map((m) => m.registrationId), reversed)
  assert.deepEqual(r.body.data.members.map((m) => m.leg), [1, 2, 3, 4])

  const stale = await squadCall(teamId, 'reorder', session, { legs: ids.slice(1) })
  assert.equal(stale.status, 409, JSON.stringify(stale.body))
  assert.equal(stale.body.code, 'invalid_legs')
  await sleep(300)
  assert.equal((await messagesTo(me)).length, 1, 'the sign-up confirmation only')
  assert.equal((await messagesTo(partner)).length, 1)

  await setLegOrder(event.categoryIds[0], false)
  const off = await squadCall(teamId, 'reorder', session, { legs: ids })
  assert.equal(off.status, 409, JSON.stringify(off.body))
  assert.equal(off.body.code, 'leg_order_off')
})

test('T-42 an unknown action is refused in Polish', async () => {
  const { teamId, session } = await freeTeam()
  const r = await squadCall(teamId, 'remove', session)
  assert.equal(r.status, 422, JSON.stringify(r.body))
  assert.deepEqual(r.body, { error: 'Nie rozpoznano tej zmiany składu.', code: 'invalid_op' })
})

test('T-42 squad_closed: every edit → 409 with the copy, no participant written, no e-mail; get still answers', async () => {
  const { event, partner, session, teamId } = await freeTeam()
  const { error } = await db().from('registration_settings')
    .update({ closes_at: new Date(Date.now() - 60_000).toISOString() }).eq('event_id', event.eventId)
  if (error) throw error
  const before = await rows('participants', { event_id: event.eventId })
  const regs = await byEvent(event.eventId)
  const old = regs.find((r) => r.email === partner)
  const next = runnerEmail('late')
  const person = swapIn(next)
  for (const [action, over] of [['swap', { registrationId: old.id, person }], ['add', { person }], ['reorder', { legs: regs.map((r) => r.id) }]]) {
    const r = await squadCall(teamId, action, session, over)
    assert.equal(r.status, 409, `${action}: ${JSON.stringify(r.body)}`)
    assert.deepEqual(r.body, { error: SQUAD_CLOSED, code: 'squad_closed' })
  }
  assert.equal((await rows('participants', { event_id: event.eventId })).length, before.length)
  assert.deepEqual(await messagesTo(next), [])
  const read = await squadCall(teamId, 'get', session)
  assert.equal(read.status, 200)
  assert.equal(read.body.data.team.editsOpen, false)
})

// ---------------------------------------------------------------- T-43 reads

const listFor = (eventId, session = owner) => call('list-event-registrations', { eventId }, session)

test('T-43 list-event-registrations: one team, size 4, consentAccepted 3, the captain named, and a member account still gets 404', async () => {
  const { event, body, teamId } = await freeTeam()
  const r = await listFor(event.eventId)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.teams.length, 1)
  assert.deepEqual(r.body.teams[0], {
    id: teamId, name: body.teamName, competition: 'Sztafeta', size: 4, consentAccepted: 3,
    captain: 'Ola Leśna', status: 'confirmed', paymentStatus: 'free', paidOffline: false, fee: 0, expiresAt: null,
    // Plan 6: the row the team's ⋯ acts on.
    captainId: r.body.data.find((row) => row.name === 'Ola Leśna').id,
  })
  assert.equal(r.body.data.length, 4)
  for (const row of r.body.data) {
    assert.deepEqual(row.team, { id: teamId, name: body.teamName, size: 4, consentAccepted: 3 })
    assert.equal(row.paymentStatus, 'free')
  }
  assert.equal(r.body.counts.free, 4, 'counts stay per person (D5-32)')

  const member = await sessionFor('member@zatyrani-test.local')
  const denied = await listFor(event.eventId, member)
  assert.equal(denied.status, 404, JSON.stringify(denied.body))
})

test('T-43 an individual row has team null, and a team of a paid event reads paid on every member, the swapped-in one too', async () => {
  const { event, session, teamId, partner } = await paidTeam()
  const old = (await byEvent(event.eventId)).find((r) => r.email === partner)
  const swapped = await squadCall(teamId, 'swap', session, { registrationId: old.id, person: swapIn(runnerEmail('next')) })
  assert.equal(swapped.status, 200, JSON.stringify(swapped.body))

  const r = await listFor(event.eventId)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const liveRows = r.body.data.filter((x) => x.status === 'confirmed')
  assert.equal(liveRows.length, 4)
  assert.deepEqual(liveRows.map((x) => x.paymentStatus), ['paid', 'paid', 'paid', 'paid'])
  assert.equal(r.body.counts.paid, 4)
  assert.equal(r.body.counts.free, 0)
  assert.equal(r.body.teams[0].paymentStatus, 'paid')

  const empty = await listFor((await freeTeamEvent(owner)).eventId)
  assert.deepEqual(empty.body.teams, [])
})

test('T-43 a 0 zł fee on a paid event reads free on every member; a pending team reads awaiting', async () => {
  const event = await paidTeamEvent(owner, { price: 0 })
  const me = runnerEmail('capt')
  const body = await teamBody(event, fourOf(me, runnerEmail('adult')))
  assert.equal((await call('register-team', body, await sessionFor(me))).status, 201)
  const zero = await listFor(event.eventId)
  assert.deepEqual(zero.body.data.map((x) => x.paymentStatus), ['free', 'free', 'free', 'free'])

  const { event: other } = await pendingTeam()
  const pending = await listFor(other.eventId)
  assert.deepEqual(pending.body.data.map((x) => x.paymentStatus), ['awaiting', 'awaiting', 'awaiting', 'awaiting'])
  assert.equal(pending.body.teams[0].status, 'pending_payment')
  assert.equal(pending.body.teams[0].paymentStatus, 'awaiting')
  assert.ok(pending.body.teams[0].fee > 0, 'the one fee, for „Zgłoszenia”')
  assert.ok(Date.parse(pending.body.teams[0].expiresAt) > Date.now(), 'and its deadline')
})

test('T-43 ZGODY a/b counts live members only: a swap cannot inflate b, an accepted-then-swapped member leaves a, a signature in the office counts', async () => {
  const { event, partner, session, teamId } = await freeTeam()
  const regs = await byEvent(event.eventId)
  const old = regs.find((r) => r.email === partner)
  const next = runnerEmail('next')
  assert.equal((await squadCall(teamId, 'swap', session, { registrationId: old.id, person: swapIn(next) })).status, 200)

  let r = await listFor(event.eventId)
  assert.equal(r.body.data.length, 5, 'the swapped-out row stays in the list')
  assert.equal(r.body.teams[0].size, 4)
  assert.equal(r.body.teams[0].consentAccepted, 3)

  const added = (await byEvent(event.eventId)).find((x) => x.email === next)
  const office = await call('mark-consent-office', { registrationId: added.id }, owner)
  assert.equal(office.status, 200, JSON.stringify(office.body))
  r = await listFor(event.eventId)
  assert.equal(r.body.teams[0].size, 4)
  assert.equal(r.body.teams[0].consentAccepted, 4)
})

test('T-43 a team whose order was cancelled leaves `teams`; its rows keep a team of size 0', async () => {
  const { event, orderId, session } = await pendingTeam()
  assert.equal((await call('cancel-my-order', { orderId }, session)).status, 200)
  const r = await listFor(event.eventId)
  assert.deepEqual(r.body.teams, [])
  assert.ok(r.body.data.every((x) => x.team.size === 0 && x.paymentStatus === null))
})

test('T-43 my-event-registrations and order-status carry teamId, teamName and isCaptain; individual rows carry null and false', async () => {
  const { event, session, teamId, orderId, body, partner } = await paidTeam()
  const { slug } = await one('registration_settings', { event_id: event.eventId })
  const mine = await call('my-event-registrations', { slug }, session)
  assert.equal(mine.status, 200, JSON.stringify(mine.body))
  assert.equal(mine.body.data.length, 4)
  assert.ok(mine.body.data.every((x) => x.teamId === teamId && x.teamName === body.teamName))
  assert.deepEqual(mine.body.data.map((x) => x.isCaptain).sort(), [false, false, false, true])
  assert.equal(mine.body.data.find((x) => x.isCaptain).mine, true)

  const theirs = await call('my-event-registrations', { slug }, await sessionFor(partner))
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body))

  const status = await call('order-status', { orderId }, session)
  assert.equal(status.status, 200, JSON.stringify(status.body))
  assert.equal(status.body.data.lines.length, 1, 'one fee, one line (D5-26)')
  const [line] = status.body.data.lines
  assert.equal(line.teamId, teamId)
  assert.equal(line.teamName, body.teamName)
  assert.equal(line.isCaptain, true)
})

test('T-43 individual registrations: team null in the organizer list, null and false in the runner reads', async () => {
  const event = await paidTeamEvent(owner, {
    competitions: [BIEG(), STAFETA()], prices: { 'Bieg 9 km': 5000, Sztafeta: 24000 },
  })
  const me = runnerEmail('solo')
  const session = await sessionFor(me)
  const categoryId = (await one('competitions', { event_id: event.eventId, name: 'Bieg 9 km' })).category_id
  const created = await call('create-order', {
    categoryId, person: grownUp(me), acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true,
    displayedTotal: 5000,
  }, session)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const { orderId } = created.body.data
  const r = await listFor(event.eventId)
  assert.equal(r.body.data[0].team, null)
  const status = await call('order-status', { orderId }, session)
  assert.equal(status.body.data.lines[0].teamId, null)
  assert.equal(status.body.data.lines[0].teamName, null)
  assert.equal(status.body.data.lines[0].isCaptain, false)
})

// ---------------------------------------------------------------- task-5a-review.md items 1 and 2

test('T-45 a team name with line breaks is stored and mailed as one line (task-5a-review.md item 1)', async () => {
  const event = await freeTeamEvent(owner)
  const me = runnerEmail('capt')
  const suffix = crypto.randomBytes(3).toString('hex')
  const body = await teamBody(event, fourOf(me, runnerEmail('adult')), { teamName: `Wilki\r\n  Stado\t${suffix}` })
  const r = await call('register-team', body, await sessionFor(me))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const clean = `Wilki Stado ${suffix}`
  assert.equal((await teamsOf(event.eventId))[0].name, clean)
  const [mail] = await waitForMail(me)
  assert.doesNotMatch(mail.subject, /[\r\n\t]/)
  assert.ok(mail.subject.includes(clean))
})

let injectSql
const injectDb = () => (injectSql ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
after(async () => { if (injectSql) await injectSql.end() })

/** LOCAL stack only: add_payment_attempt raises `message` for orders of a marked buyer. Dropped afterwards. */
async function withAttemptRefused(message, run) {
  await injectDb().unsafe(`
    CREATE OR REPLACE FUNCTION public.test_refuse_team_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.orders o WHERE o.id = NEW.order_id AND o.buyer_email LIKE 'refuse-attempt-%') THEN
        RAISE EXCEPTION '${message}';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS test_refuse_team_attempt ON public.payment_attempts;
    CREATE TRIGGER test_refuse_team_attempt BEFORE INSERT ON public.payment_attempts
      FOR EACH ROW EXECUTE FUNCTION public.test_refuse_team_attempt();`)
  try {
    await run()
  } finally {
    await injectDb().unsafe(`
      DROP TRIGGER IF EXISTS test_refuse_team_attempt ON public.payment_attempts;
      DROP FUNCTION IF EXISTS public.test_refuse_team_attempt();`)
  }
}

for (const [message, status, expected] of [
  ['full', 409, { error: NO_PLACES, code: 'full' }],
  ['not_payable', 409, { error: 'Zapisy są zamknięte.', code: 'closed' }],
]) {
  test(`T-45 add_payment_attempt refuses with ${message}: ${status}, the order cancelled attempt_refused, the name free (task-5a-review.md item 2)`, async () => {
    await withAttemptRefused(message, async () => {
      const event = await paidTeamEvent(owner)
      const me = `refuse-attempt-${crypto.randomBytes(4).toString('hex')}@test.local`
      const body = await teamBody(event, fourOf(me, runnerEmail('adult')))
      const r = await call('register-team', body, await sessionFor(me))
      assert.equal(r.status, status, JSON.stringify(r.body))
      assert.deepEqual(r.body, expected)
      const [order] = await rows('orders', { event_id: event.eventId })
      assert.equal(order.status, 'cancelled')
      assert.equal(order.cancelled_reason, 'attempt_refused')
      assert.ok((await teamsOf(event.eventId))[0].released_at)
      assert.equal((await competitionOf(event.categoryIds[0])).taken, 0)
    })
  })
}
